//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * The restricted operation registry: the ONLY code that drives walletd / mutates the budget. Each op
 * declares a risk tier; the authorizer (server.js) is the single gate in front of it.
 */
"use strict";

const crypto = require("node:crypto");
const { httpError, toAmount, big } = require("./http_util");

function createOps({
  store, saveStore, snapshotBudget, txlog, walletd, conn, OnChainBudget, newInvoiceId, TIERS,
  budgetTemplate: BUDGET_TEMPLATE, resolveMerchant, lookupMerchant, liveBudget, readChainBudget, runChainOp, idemKey,
  dashboardState, pendingResult, keySession, chainMessage,
}) {
  // These `run` functions are the ONLY code that drives walletd / mutates the budget. Each declares a
  // risk tier; high-risk ones require a step-up confirmation. The authorizer (below) is the single
  // gate in front of them — request handlers never call walletd directly, so a compromised web layer
  // is confined to exactly this reviewed set of actions.
  const OPS = {
    // Fund + mint a new budget: moves owner funds and sets the on-chain rules → high-risk.
    createBudget: {
      tier: TIERS.ADMIN,
      highRisk: true,
      async run(body, ctx) {
        if (store.budget) throw httpError(409, "A budget is already open. Reset it to create a new one.");
        // #3: an earlier open that came back "unknown" may have landed on chain even though no budget is
        // mounted yet. Refuse to open another while that record is unresolved — otherwise a retry funds a
        // SECOND budget. Reconcile (startup + periodic) settles the record and mounts the real one.
        const inflight = txlog.pendingOrUnknown().filter((r) => r.op === "createBudget");
        if (inflight.length) {
          throw httpError(409,
            "A previous budget creation is still unresolved (tx " + (inflight[0].txId || "pending") +
            "). It may already have opened a budget on chain — wait for it to reconcile before opening another.");
        }
        const fund = toAmount(body.fund, "fund");
        const perTxCap = toAmount(body.perTxCap, "per-transaction cap");
        const dailyCap = toAmount(body.dailyCap, "daily cap");
        const epochsPerWindow = Math.max(1, Number(body.epochsPerWindow) || 10);
        if (big(perTxCap) > big(dailyCap)) throw httpError(400, "Per-transaction cap cannot exceed the daily cap.");
        if (big(fund) <= 0n) throw httpError(400, "Funding amount must be greater than zero.");
        const wlNames = Array.isArray(body.whitelist) ? body.whitelist : [];
        const whitelist = [];
        for (const n of wlNames) whitelist.push(await resolveMerchant(n));
        const c = await walletd();
        const budget = new OnChainBudget(c, BUDGET_TEMPLATE, conn.ownerAddr);
        budget.epochsPerWindow = epochsPerWindow;
        const key = idemKey(body, "createBudget:" + crypto.randomUUID());
        const r = await runChainOp(
          key,
          "createBudget",
          null, // the new component address is unknown until the open confirms
          { fund, perTxCap, dailyCap, epochsPerWindow, whitelist: whitelist.length },
          () => budget.open({ fund, perTxCap, dailyCap, epochsPerWindow, whitelist }),
        );
        ctx.meta.txId = r.record.txId;
        ctx.meta.params = { fund, perTxCap, dailyCap, epochsPerWindow, whitelist: whitelist.length };
        if (r.outcome === "unknown") return await pendingResult(r.record, "Budget creation");
        txlog.settle(key, { component: budget.component }); // tag the record with its new budget
        snapshotBudget(budget); // only now is the component live on chain
        ctx.meta.txId = budget.component;
        return await dashboardState();
      },
    },

    // Agent payment: money-moving, within the on-chain caps → throttled + flagged, not step-up.
    // Idempotent on the invoice id: paying the same invoice twice does not double-spend.
    pay: {
      tier: TIERS.MONEY,
      async run(body, ctx) {
        const b = await liveBudget();
        if (!b) throw httpError(409, "No budget is open.");
        const merchant = await resolveMerchant(body.merchant);
        const amount = toAmount(body.amount, "amount");
        const agentTag = (body.agentTag || "agent").toString().slice(0, 24);
        const invoiceId = body.invoiceId ? String(body.invoiceId) : newInvoiceId();
        // Free-text memo is recorded in the journal/receipt for the caller's reference. (It is NOT the
        // on-chain memo — that public plaintext memo carries the encoded invoice id + agent tag; see invoice.ts.)
        const memo = body.memo != null ? String(body.memo).slice(0, 120) : undefined;
        // Which session badge signs this payment is decided by WHO is calling (the API key), not by the
        // request body — a client must never be able to pay as another key's session.
        const session = ctx.apiKeyId ? keySession(b, ctx.apiKeyId) : "default";
        const key = idemKey(body, "pay:" + invoiceId);
        // S-7: for a key-authenticated pay, verify the session on chain RIGHT NOW with a dry-run before
        // the real submit. A session revoked a moment ago (or any cap/whitelist violation) is refused by
        // the validator, so this catches it authoritatively — not just from this process's cached
        // snapshot — and never spends a fee on a certain reject. Dashboard/owner pays skip the probe.
        const submit = ctx.apiKeyId
          ? async () => {
              try {
                const reason = await b.wouldReject(merchant, amount, { memo, session });
                if (reason) {
                  const err = new Error(reason);
                  err.chainRejected = true; // the validator refused it on a dry-run — a definitive verdict
                  throw err;
                }
              } catch (e) {
                // A TRANSIENT preflight failure (indexer/transport hiccup) is not a verdict — the
                // validator never ruled. Skip the probe and let the real submit be the authority (its
                // own transient handling records the tx `pending`), instead of surfacing a phantom
                // chainRejected that burns the idempotency key on an infra blip. Re-throw a genuine
                // reject or any other error. (#3)
                if (!e || !e.transient) throw e;
              }
              return b.payInvoice({ merchant, invoiceId, amount, agentTag, session });
            }
          : () => b.payInvoice({ merchant, invoiceId, amount, agentTag, session });
        let r;
        try {
          r = await runChainOp(
            key,
            "pay",
            b.component,
            { merchant, amount, invoiceId, memo, session },
            submit,
            { merchant, amount, memo }, // fingerprint on what the money DOES, not the (often auto-generated) invoiceId
            { guardInflight: false }, // pay dedups on the caller's Idempotency-Key; its fingerprint omits the caller, so a fingerprint-only inflight guard would block two agents paying alike (multi-tenant)
          );
        } catch (e) {
          // Surface the chain's own reason as a friendly 422, distinct from a server fault.
          if (e.idempotencyConflict || e.inflightDuplicate) throw e; // preserve the 409 (reused key with different params, or an identical op still in flight)
          throw httpError(422, chainMessage(e));
        }
        ctx.meta.txId = (r.record && r.record.txId) || invoiceId;
        ctx.meta.params = { merchant, amount, invoiceId, memo, session };
        // No snapshotBudget: the ledger + spend are rebuilt from chain / the journal, not persisted here.
        if (r.outcome === "unknown") return await pendingResult(r.record, "Payment");
        return { ...(await dashboardState()), paid: { amount, merchant, invoiceId }, replayed: Boolean(r.replay) };
      },
    },

    // Expand the on-chain whitelist → high-risk (grows who the agent may pay).
    addMerchant: {
      tier: TIERS.ADMIN,
      highRisk: true,
      async run(body, ctx) {
        const b = await liveBudget();
        if (!b) throw httpError(409, "No budget is open.");
        const address = await resolveMerchant(body.merchant);
        if (b.whitelist.includes(address)) throw httpError(400, "That merchant is already whitelisted.");
        const key = idemKey(body, "addMerchant:" + crypto.randomUUID());
        const r = await runChainOp(key, "addMerchant", b.component, { merchant: address }, () => b.addMerchant(address));
        ctx.meta.txId = r.record.txId;
        ctx.meta.params = { merchant: address };
        if (r.outcome === "unknown") return await pendingResult(r.record, "Add-merchant");
        snapshotBudget(b); // refresh the cached whitelist (chain remains authority)
        return await dashboardState();
      },
    },

    // Shrink the on-chain whitelist → high-risk (owner-badge call; changes who the agent may pay).
    // Resolution never provisions an account; the merchant must be on the CHAIN whitelist right now.
    removeMerchant: {
      tier: TIERS.ADMIN,
      highRisk: true,
      async run(body, ctx) {
        const b = await liveBudget();
        if (!b) throw httpError(409, "No budget is open.");
        const { name, address } = lookupMerchant(body.merchant);
        // Chain is the authority on membership; fall back to the cached mirror only if the read fails.
        let whitelist = b.whitelist || [];
        try {
          whitelist = (await readChainBudget(b.component)).whitelist;
        } catch (e) {
          console.error("warn: removeMerchant could not read the chain whitelist:", e.message);
        }
        if (!whitelist.includes(address)) throw httpError(400, "That merchant is not on the whitelist.");
        const key = idemKey(body, "removeMerchant:" + crypto.randomUUID());
        let r;
        try {
          r = await runChainOp(key, "removeMerchant", b.component, { merchant: address }, () => b.removeMerchant(address));
        } catch (e) {
          if (e.idempotencyConflict || e.inflightDuplicate) throw e; // preserve the 409 (reused key with different params, or an identical op still in flight)
          throw httpError(422, chainMessage(e));
        }
        ctx.meta.txId = r.record.txId;
        ctx.meta.params = { merchant: address };
        if (r.outcome === "unknown") return await pendingResult(r.record, "Remove-merchant");
        snapshotBudget(b); // refresh the cached whitelist (chain remains authority)
        return { ...(await dashboardState()), removed: { name, address } };
      },
    },

    // Change both caps on chain → high-risk (raising them widens what the agent can spend).
    // The step-up token is bound to the exact (perTxCap, dailyCap) pair — see confirmParams in stepup.js.
    setLimits: {
      tier: TIERS.ADMIN,
      highRisk: true,
      async run(body, ctx) {
        const b = await liveBudget();
        if (!b) throw httpError(409, "No budget is open.");
        const perTxCap = toAmount(body.perTxCap, "per-transaction cap");
        const dailyCap = toAmount(body.dailyCap, "daily cap");
        if (big(perTxCap) > big(dailyCap)) throw httpError(400, "Per-transaction cap cannot exceed the daily cap.");
        const key = idemKey(body, "setLimits:" + crypto.randomUUID());
        let r;
        try {
          r = await runChainOp(key, "setLimits", b.component, { perTxCap, dailyCap }, () => b.setLimits(perTxCap, dailyCap));
        } catch (e) {
          if (e.idempotencyConflict || e.inflightDuplicate) throw e; // preserve the 409 (reused key with different params, or an identical op still in flight)
          throw httpError(422, chainMessage(e));
        }
        ctx.meta.txId = r.record.txId;
        ctx.meta.params = { perTxCap, dailyCap };
        if (r.outcome === "unknown") return await pendingResult(r.record, "Set-limits");
        snapshotBudget(b); // refresh the cached caps (chain remains authority)
        return await dashboardState();
      },
    },

    // Pull funds out of the vault back to the owner → highest-risk money extraction.
    withdraw: {
      tier: TIERS.ADMIN,
      highRisk: true,
      async run(body, ctx) {
        const b = await liveBudget();
        if (!b) throw httpError(409, "No budget is open.");
        const amount = toAmount(body.amount, "amount");
        // Treasury ceiling comes from the CHAIN vault balance, not a local accumulator.
        let chain = null;
        try {
          chain = await readChainBudget(b.component);
        } catch (e) {
          console.error("warn: withdraw could not read chain treasury:", e.message);
        }
        if (chain && chain.vaultBalance != null && big(amount) > big(chain.vaultBalance)) {
          throw httpError(400, `Only ${chain.vaultBalance} remains in the treasury.`);
        }
        const key = idemKey(body, "withdraw:" + crypto.randomUUID());
        const r = await runChainOp(key, "withdraw", b.component, { amount }, () => b.withdraw(amount));
        ctx.meta.txId = r.record.txId;
        ctx.meta.params = { amount };
        if (r.outcome === "unknown") return await pendingResult(r.record, "Withdrawal");
        return await dashboardState(); // withdrawn total now derives from the journal
      },
    },

    // Add funds into the vault: money-moving (from the owner account) → throttled + flagged.
    topUp: {
      tier: TIERS.MONEY,
      async run(body, ctx) {
        const b = await liveBudget();
        if (!b) throw httpError(409, "No budget is open.");
        const amount = toAmount(body.amount, "amount");
        if (big(amount) <= 0n) throw httpError(400, "Top-up amount must be greater than zero.");
        const key = idemKey(body, "topUp:" + crypto.randomUUID());
        let r;
        try {
          r = await runChainOp(key, "topUp", b.component, { amount }, () => b.topUp(amount));
        } catch (e) {
          if (e.idempotencyConflict || e.inflightDuplicate) throw e; // preserve the 409 (reused key with different params, or an identical op still in flight)
          throw httpError(422, chainMessage(e));
        }
        ctx.meta.txId = r.record.txId;
        ctx.meta.params = { amount };
        if (r.outcome === "unknown") return await pendingResult(r.record, "Top-up");
        return await dashboardState(); // funded total now derives from the journal
      },
    },

    // Global on-chain kill switch for the agent → high-risk, irreversible.
    revoke: {
      tier: TIERS.ADMIN,
      highRisk: true,
      async run(body, ctx) {
        const b = await liveBudget();
        if (!b) throw httpError(409, "No budget is open.");
        if (b.revoked) throw httpError(400, "This budget is already revoked.");
        const key = idemKey(body, "revoke:" + crypto.randomUUID());
        const r = await runChainOp(key, "revoke", b.component, {}, () => b.revoke());
        ctx.meta.txId = r.record.txId;
        ctx.meta.params = {};
        if (r.outcome === "unknown") return await pendingResult(r.record, "Revoke");
        snapshotBudget(b);
        return await dashboardState();
      },
    },

    // Mint a new agent-session badge → high-risk (grants fresh spending authority).
    // Idempotent on the session label.
    issueSession: {
      tier: TIERS.ADMIN,
      highRisk: true,
      async run(body, ctx) {
        const b = await liveBudget();
        if (!b) throw httpError(409, "No budget is open.");
        const session = String(body.session || "").trim();
        if (!session) throw httpError(400, "A session label is required.");
        // Keep this in lockstep with the SDK/TS client's SESSION_RE (no spaces): a label the server
        // accepts but the client then rejects would surface as a confusing 422 downstream (#13).
        if (!/^[A-Za-z0-9_.\-]{1,64}$/.test(session)) {
          throw httpError(400, "Use letters, numbers, '.', '-' or '_' (no spaces, max 64).");
        }
        // A label can be minted once: `revoke_session` does not burn the badge, so the engine refuses to
        // re-create its NFT. Re-enabling means a NEW label (the API keys use generations, key-<id>.2 …).
        if ((b.sessions || []).includes(session)) throw httpError(400, "That session label already exists.");
        const key = idemKey(body, "issueSession:" + session);
        let r;
        try {
          r = await runChainOp(key, "issueSession", b.component, { session }, () => b.issueAgentBadge(session));
        } catch (e) {
          if (e.idempotencyConflict || e.inflightDuplicate) throw e; // preserve the 409 (reused key with different params, or an identical op still in flight)
          throw httpError(422, chainMessage(e));
        }
        ctx.meta.txId = r.record.txId;
        ctx.meta.params = { session };
        if (r.outcome === "unknown") return await pendingResult(r.record, "Issue-session");
        snapshotBudget(b);
        return await dashboardState();
      },
    },

    // Revoke a single agent session → high-risk, irreversible for that session.
    revokeSession: {
      tier: TIERS.ADMIN,
      highRisk: true,
      async run(body, ctx) {
        const b = await liveBudget();
        if (!b) throw httpError(409, "No budget is open.");
        const session = String(body.session || "").trim();
        if (!session) throw httpError(400, "A session label is required.");
        if ((b.revokedSessions || []).includes(session)) throw httpError(400, "That session is already revoked.");
        const key = idemKey(body, "revokeSession:" + session);
        let r;
        try {
          r = await runChainOp(key, "revokeSession", b.component, { session }, () => b.revokeSession(session));
        } catch (e) {
          if (e.idempotencyConflict || e.inflightDuplicate) throw e; // preserve the 409 (reused key with different params, or an identical op still in flight)
          throw httpError(422, chainMessage(e));
        }
        ctx.meta.txId = r.record.txId;
        ctx.meta.params = { session };
        if (r.outcome === "unknown") return await pendingResult(r.record, "Revoke-session");
        snapshotBudget(b);
        return await dashboardState();
      },
    },

    // Detach the local budget view (no chain effect) → still high-risk (can hide a live budget).
    resetLocal: {
      tier: TIERS.ADMIN,
      highRisk: true,
      async run(_body, ctx) {
        // LOCAL ONLY. Detaches the dashboard's budget reference. It does NOT touch the chain: the
        // AgentBudget component, its vault and any remaining treasury stay exactly as they are, and no
        // funds are withdrawn or refunded. The tx journal is PRESERVED (it is an operation record, and
        // its rows are scoped by component, so a later new budget starts with its own clean history).
        store.budget = null;
        saveStore();
        ctx.meta.params = {};
        return {
          ...(await dashboardState()),
          notice:
            "Local view cleared. The on-chain budget component, its vault and any remaining treasury " +
            "still exist on chain — reset does not withdraw or refund funds. The operation journal is kept.",
        };
      },
    },

    // Emergency stop: freeze every money/admin action dashboard-wide (independent of on-chain revoke).
    // #12: an emergency stop must be EASY to engage and HARD to lift. `freeze` therefore skips the
    // step-up gate (`noStepUp`) and the rate limiter (`bypassRateLimit`) — a logged-in operator can
    // always hit the brakes, even while a flood is tripping limits. It stays `highRisk` so the action
    // is still durably audited. `unfreeze` below keeps the full step-up gate (hard to lift).
    freeze: {
      tier: TIERS.ADMIN,
      highRisk: true,
      noStepUp: true,
      bypassRateLimit: true,
      async run(_body, ctx) {
        store.frozen = true;
        saveStore();
        ctx.meta.params = {};
        return { ...(await dashboardState()), notice: "Dashboard frozen. All fund-moving actions are blocked until you unfreeze." };
      },
    },

    // Lift the emergency stop. Allowed even while frozen (it is the way out), but still step-up gated.
    unfreeze: {
      tier: TIERS.ADMIN,
      highRisk: true,
      allowWhenFrozen: true,
      async run(_body, ctx) {
        store.frozen = false;
        saveStore();
        ctx.meta.params = {};
        return { ...(await dashboardState()), notice: "Dashboard unfrozen. Fund-moving actions are enabled again." };
      },
    },
  };

  return OPS;
}

module.exports = { createOps };
