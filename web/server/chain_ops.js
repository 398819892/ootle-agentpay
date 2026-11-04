//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * The idempotent chain-op runner: one journal record per fund-moving op with a pending ->
 * confirmed | rejected | unknown lifecycle, in-process + cross-process (claims) idempotency, and the
 * reconciler that settles open records against the chain by tx id.
 */
"use strict";

const { httpError } = require("./http_util");
const { paramFingerprint, conflicts: fpConflicts } = require("./idempotency");

function createChainOps({
  store, saveStore, snapshotBudget, txlog, claims, claimWaitMs: CLAIM_WAIT_MS, walletd, conn, OnChainBudget,
  budgetTemplate: BUDGET_TEMPLATE, firstPayEvent, chainMessage,
}) {
  // ---- idempotent chain-op runner (tx lifecycle) ------------------------------------------------
  /** The idempotency key for an op: an explicit client key, else a sensible per-op default. */
  function idemKey(body, fallback) {
    const k = body && (body.idempotencyKey || body.idemKey);
    return k ? String(k).slice(0, 128) : fallback;
  }

  /**
   * Settle a single open (pending/unknown) journal record against the chain by its tx id. Promotes it
   * to confirmed/rejected, or leaves it open if the chain still has no verdict / no tx id to check.
   */
  async function reconcileRecord(rec) {
    if (!rec || !txlog.isOpen(rec.status) || !rec.txId) return rec;
    const c = await walletd();
    const got = await c.getResult(rec.txId);
    if (got.status === "accept") {
      const event = rec.op === "pay" ? firstPayEvent(got.result) || rec.event : rec.event;
      // An open budget that came back "unknown" ACTUALLY LANDED: the chain accepted it and created a
      // component the dashboard never recorded. Recover it from the confirmed result and mount it, so
      // the dashboard attaches to the on-chain budget instead of pretending none exists — which would
      // also let a retry fund a SECOND budget (#3). Skip if a budget is already mounted (a later open
      // won) or the record already carries its component.
      if (rec.op === "createBudget" && !store.budget && !rec.component) {
        const budget = new OnChainBudget(c, BUDGET_TEMPLATE, conn.ownerAddr);
        if (rec.params && rec.params.epochsPerWindow) budget.epochsPerWindow = Number(rec.params.epochsPerWindow);
        let comp;
        try {
          comp = await budget.attachFromOpenResult(got.result, Object.values(store.merchants));
        } catch (e) {
          // The tx is confirmed but the component/badges could not be read yet (e.g. indexer lag).
          // Leave the record OPEN so a later reconcile retries the mount, rather than settling it
          // confirmed-but-unmounted and losing the recovery trigger.
          console.error(`reconcile: createBudget ${rec.key} confirmed but mount failed, will retry:`, e.message);
          return rec;
        }
        if (!comp) {
          console.error(`reconcile: createBudget ${rec.key} confirmed but no new component in result; settling without mount`);
          return txlog.settle(rec.key, { status: "confirmed", event });
        }
        if (rec.params) {
          budget.perTxCap = String(rec.params.perTxCap ?? "0");
          budget.dailyCap = String(rec.params.dailyCap ?? "0");
        }
        snapshotBudget(budget); // mount the recovered budget (chain stays authoritative in dashboardState)
        return txlog.settle(rec.key, { status: "confirmed", component: comp, event });
      }
      // An issueSession that came back UNKNOWN actually LANDED: the badge is on chain, but the issued-
      // session cache (store.budget.sessions) is only updated on the confirmed run-path (snapshotBudget).
      // With REQUIRE_KEY_SESSIONS=true (the default) that leaves the API key permanently 403 after any
      // unknown during issuance (N-1), since keySessionInfo derives `issued` from this cache. Rebuild it
      // from the confirmed record so the key can pay. (A revoke that went unknown needs no cache fix: the
      // pay path re-checks revocation on chain with a dry-run right before submit — S-7.)
      if (rec.op === "issueSession" && rec.params && rec.params.session && store.budget) {
        if (!Array.isArray(store.budget.sessions)) store.budget.sessions = ["default"];
        if (!store.budget.sessions.includes(rec.params.session)) {
          store.budget.sessions.push(rec.params.session);
          saveStore();
        }
      }
      return txlog.settle(rec.key, { status: "confirmed", event });
    }
    if (got.status === "reject") {
      return txlog.settle(rec.key, { status: "rejected", reason: got.reason });
    }
    return rec; // still pending on chain
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CLAIM_POLL_MS = 25;

  /** The idempotency key was reused with DIFFERENT parameters — a 409 the caller must surface, never a
   *  silent replay of the prior receipt. */
  function idempotencyConflict(key) {
    return httpError(
      409,
      "This idempotency key was already used with different parameters. Use a new key for a different operation.",
      { idempotencyConflict: true, key },
    );
  }

  /** Replay the outcome of a journal record that already exists, settling it against chain first if
   *  it is still open. Never resubmits — an unresolved open record is reported as `unknown`. */
  async function replayPrior(prior) {
    if (prior.status === "confirmed") return { outcome: "confirmed", record: prior, replay: true };
    if (prior.status === "rejected") throw httpError(422, prior.reason || "Previously rejected.");
    // pending / unknown — try to settle it before considering a resubmit.
    const settled = await reconcileRecord(prior);
    if (settled.status === "confirmed") return { outcome: "confirmed", record: settled, replay: true };
    if (settled.status === "rejected") throw httpError(422, settled.reason || "Previously rejected.");
    // Still unresolved on chain: do NOT resubmit (that would double-spend). Report it as unknown.
    return { outcome: "unknown", record: settled, replay: true };
  }

  /**
   * A different instance holds the claim for this key, so we must NOT submit. Observe the SHARED
   * journal until the winner's outcome is terminal, then replay it. If it carries a tx id while still
   * open we may settle it against chain ourselves (read-only, idempotent). If it never resolves within
   * the wait budget (winner slow, or crashed mid-flight), report `unknown` — the existing startup
   * reconcile settles it later by its tx id, and we NEVER resubmit (that is the double-spend we block).
   */
  async function replayForeignClaim(key, claim, fp) {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    for (;;) {
      txlog.reload(); // merge whatever the winner has persisted into our view
      const rec = txlog.get(key);
      if (rec) {
        // The winner's journal record is authoritative for the fingerprint too: a mismatch here is the
        // same reused-key-different-params conflict, caught once the winner has persisted its record.
        if (fp != null && fpConflicts(rec.fp, fp)) throw idempotencyConflict(key);
        if (txlog.isTerminal(rec.status)) return await replayPrior(rec);
        if (rec.txId) {
          const settled = await reconcileRecord(rec); // read-only get_result; promotes if chain has a verdict
          if (txlog.isTerminal(settled.status)) return await replayPrior(settled);
        }
      }
      if (Date.now() >= deadline) {
        const record = rec || {
          key,
          op: null,
          component: null,
          status: "unknown",
          txId: null,
          reason: "claimed by another instance; outcome not yet observed within the wait budget",
        };
        return { outcome: "unknown", record, replay: true };
      }
      await sleep(CLAIM_POLL_MS);
    }
  }

  /**
   * Run a fund-moving op exactly once per idempotency key, journaling its full lifecycle:
   *   pending (persisted before submit) → confirmed | rejected | unknown.
   * `submitFn` performs the chain call (an OnChainBudget method) and returns the finalized result;
   * it sets `conn.wd.lastTxId` as a side effect. Returns { outcome, record, res, replay }.
   *
   * Idempotency is enforced at two layers: an in-process journal (fast, single-instance) AND a
   * cross-process filesystem claim (claims.js) so that multiple instances sharing one filesystem never
   * submit the same key twice. See docs/stability.md for the cross-HOST limit that remains.
   */
  async function runChainOp(key, opName, component, params, submitFn, fpParams, opts = {}) {
    // Bind this key to a fingerprint of its FUNDING-RELEVANT parameters: a repeat of the key with
    // different parameters (amount, payee, memo…) must NOT silently replay the prior receipt (see
    // idempotency.js). The fingerprint is computed from `fpParams` when the op supplies it, else from
    // `params`. The distinction matters because `params` also carries non-funding identifiers — notably
    // a server-GENERATED invoiceId, which is random per call and so must be excluded, or two legitimate
    // retries under one key would fingerprint differently and spuriously conflict. Recorded on both the
    // journal record and the cross-process claim marker so either layer can detect a real mismatch.
    const fp = paramFingerprint(opName, component, fpParams !== undefined ? fpParams : params);

    // Fast path — a record already visible IN THIS PROCESS (a same-process replay, or one recovered
    // from the journal at startup). This is the single-instance idempotency guarantee, unchanged.
    const prior = txlog.get(key);
    if (prior) {
      if (fpConflicts(prior.fp, fp)) throw idempotencyConflict(key);
      return await replayPrior(prior);
    }

    // In-flight duplicate guard: an IDENTICAL operation (same fingerprint) is still unresolved under a
    // DIFFERENT key. That is the refresh-and-retry case — an owner op whose stable client key was lost
    // (a page reload drops the in-memory idempotency slot, so the retry mints a fresh random key) while
    // the first submit is still pending/unknown on chain. Without this, the fresh key sidesteps the
    // same-key fast path above and submits a SECOND real tx (a double-spend). Refuse instead, exactly
    // like the createBudget inflight guard, and let reconcile settle the original by its tx id.
    //   NOT applied to `pay` (opts.guardInflight === false): its fingerprint excludes the caller, so two
    //   different agents legitimately paying the same merchant the same amount would collide here. The
    //   pay path dedups on the caller-supplied Idempotency-Key instead (required on /api/v1; persisted
    //   across reloads by the dashboard). Every other op has a single owner caller, so same-fingerprint
    //   + still-open is always an accidental resubmit.
    if (opts.guardInflight !== false && fp) {
      const twin = txlog.pendingOrUnknown().find((r) => r.key !== key && r.op === opName && r.fp === fp);
      if (twin) {
        throw httpError(
          409,
          "An identical " + opName + " is still unresolved (tx " + (twin.txId || "pending") +
            "). Wait for it to confirm or reconcile before retrying, so it is not submitted twice.",
          { inflightDuplicate: true, key: twin.key },
        );
      }
    }

    // No local record yet. Before submitting anything, take the CROSS-PROCESS claim on this key. On a
    // shared filesystem `fs.open(…,"wx")` lets exactly one instance win; every other instance that
    // races the same key loses and must NOT submit — otherwise the chain (which has no invoice dedup)
    // executes the payment twice. This is the multi-instance double-spend the B-6 harness reproduced.
    let claim;
    try {
      claim = claims.tryClaim(key, { op: opName, fp });
    } catch (e) {
      // We could not take the claim for a reason other than "already claimed" (e.g. the shared dir is
      // unwritable). Fail safe: do not submit on an unproven claim.
      throw httpError(503, "Could not take the idempotency claim (shared store unavailable): " + e.message);
    }
    if (!claim.won) {
      // A peer already holds this key. If its marker records a DIFFERENT fingerprint, this is a reused
      // key with different parameters — reject rather than wait to replay a receipt for another request.
      if (claim.record && fpConflicts(claim.record.fp, fp)) throw idempotencyConflict(key);
      return await replayForeignClaim(key, claim, fp);
    }

    txlog.begin({ key, op: opName, params, component, fp }); // persist pending BEFORE the chain submit (throws on fail)
    // Snapshot the client's last tx id BEFORE we submit. `conn.wd.lastTxId` is sticky — it holds the id of
    // the most recent *successful* submit on this shared client. An op that fails WITHOUT submitting
    // (a client-side precheck rejection, or a fault before submit_manifest returns) must NOT inherit
    // that previous op's tx id, or its journal record / receipt would point at an unrelated tx. So we
    // only attribute a tx id to this op when lastTxId actually advanced, or the error carries one
    // explicitly (the timeout/pending case, where run() stamps e.txId on the tx it did submit).
    const txIdBefore = conn.wd && conn.wd.lastTxId;
    const submittedTxId = () => (conn.wd && conn.wd.lastTxId && conn.wd.lastTxId !== txIdBefore ? conn.wd.lastTxId : null);
    // #8: persist the tx id to the journal the moment it is known — i.e. as soon as the client's
    // lastTxId advances (right after submit, BEFORE the up-to-minutes confirmation wait) — not only
    // after submitFn resolves. Otherwise a crash during the wait leaves the record "pending" with no
    // txId, which the reconciler cannot settle against the chain (and replay won't resubmit). Chain ops
    // are serialized, so a lastTxId that advances during this submitFn is unambiguously this op's.
    let midflightTxId = null;
    const txIdWatcher = setInterval(() => {
      const t = submittedTxId();
      if (t && !midflightTxId) {
        midflightTxId = t;
        try { txlog.settle(key, { txId: t }); } catch { /* best-effort; final settle still records it */ }
        clearInterval(txIdWatcher);
      }
    }, 200);
    let res;
    try {
      res = await submitFn();
    } catch (e) {
      clearInterval(txIdWatcher);
      const txId = (e && e.txId) || submittedTxId();
      const chainRejected = !!(e && e.chainRejected);
      // A record may be settled to the TERMINAL "rejected" only when that is provably safe:
      //   • the chain finalized a Reject (e.chainRejected) — the tx moved no funds; or
      //   • nothing was ever submitted (no txId, not flagged pending) — a pre-submit failure.
      // ANY other post-submit fault is ambiguous and must be UNKNOWN: e.pending (submitted, not
      // confirmed within the window), OR an unflagged throw AFTER a tx was submitted — a transport blip
      // during the confirm poll, or a throw while reading badges / parsing the event once the chain had
      // already Accepted. Such a tx may have landed, even succeeded, so recording it "rejected" (which
      // reconcileAll never re-checks, and a caller reads as "safe to retry") would invite a double-spend.
      // We settle it UNKNOWN and reconcile by tx id instead. (S-1)
      if (!chainRejected && ((e && e.pending) || txId)) {
        const reason = (e && e.pending)
          ? "submitted; not confirmed within the window"
          : "submitted; outcome unknown after a post-submit fault — reconcile by tx id";
        const record = txlog.settle(key, { status: "unknown", txId, reason });
        return { outcome: "unknown", record };
      }
      // Finalized chain reject, or a pre-submit fault (no tx reached the chain): record and surface it.
      txlog.settle(key, { status: "rejected", txId, reason: chainMessage(e) });
      throw e;
    }
    clearInterval(txIdWatcher);
    const txId = submittedTxId();
    const event = opName === "pay" ? firstPayEvent(res) : null;
    const record = txlog.settle(key, { status: "confirmed", txId, event });
    return { outcome: "confirmed", record, res };
  }

  /** On startup, settle every open record we can by its tx id (ledger is then rebuilt from chain). */
  async function reconcileAll() {
    const open = txlog.pendingOrUnknown();
    // Confirmed pays whose on-chain event was never captured — e.g. journaled before the topic-parse
    // fix, when a namespaced "AgentBudget.pay" topic was dropped. The ledger renders the STORED event,
    // so such a pay is invisible (money moved, no row) until its event is re-derived from chain here.
    const eventless = txlog.list().filter(
      (r) => r.op === "pay" && r.status === "confirmed" && !r.event && r.txId,
    );
    if (!open.length && !eventless.length) return { checked: 0, resolved: 0, backfilled: 0 };
    let c;
    try {
      c = await walletd();
    } catch (e) {
      console.error("reconcile: walletd unreachable, deferring:", e.message);
      return { checked: 0, resolved: 0, backfilled: 0 };
    }
    let resolved = 0;
    for (const rec of open) {
      try {
        const before = rec.status;
        const after = await reconcileRecord(rec);
        if (after.status !== before && txlog.isTerminal(after.status)) resolved += 1;
      } catch (e) {
        console.error(`reconcile: ${rec.key} failed:`, e.message);
      }
    }
    let backfilled = 0;
    for (const rec of eventless) {
      try {
        const got = await c.getResult(rec.txId);
        if (got.status === "accept") {
          const ev = firstPayEvent(got.result);
          if (ev) { txlog.settle(rec.key, { event: ev }); backfilled += 1; }
        }
      } catch (e) {
        console.error(`reconcile: backfill ${rec.key} failed:`, e.message);
      }
    }
    return { checked: open.length, resolved, backfilled };
  }

  return { idemKey, reconcileRecord, idempotencyConflict, runChainOp, reconcileAll };
}

module.exports = { createChainOps };
