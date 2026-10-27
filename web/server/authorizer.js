/**
 * Restricted authorizer — the single, audited exit for every chain operation (zero dependencies).
 *
 * WHY THIS EXISTS
 * The dashboard backend is a *custodial* service: it holds (via walletd) the keys that sign on
 * chain. If the web layer is compromised, the blast radius is whatever that process can make
 * walletd do. The on-chain AgentBudget already caps the *agent* (per-tx / daily / whitelist /
 * revoke), but the owner-side operations the server itself performs — withdraw, change the
 * whitelist, revoke, mint a new agent badge — are a separate attack surface.
 *
 * This module shrinks that surface to a fixed, reviewed set. Request handlers do NOT call walletd
 * directly; they call `authz.execute(opName, args, ctx)`. Only operations registered here can run,
 * each with a declared risk tier, and every state-changing call passes the same gauntlet:
 *
 *   1. whitelist         — an unknown opName is refused (no arbitrary chain calls)
 *   2. kill switch       — when frozen, every money/admin op is refused; reads still work
 *   3. rate limit        — money/admin ops are throttled per actor, with anomaly flags
 *   4. step-up confirm    — high-risk ops require a second confirmation independent of the login
 *                          session (a short-lived token minted by re-presenting the admin secret)
 *   5. audit             — who / what / when / tx id / result is appended to the audit log
 *
 * The full "separate signing microservice behind its own authn, the web box holding no keys at all"
 * is the next step (see docs/custody.md); this is the in-process restricted boundary.
 */
"use strict";

const TIERS = Object.freeze({ READ: "read", MONEY: "money", ADMIN: "admin" });

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

/**
 * A small sliding-window rate limiter + anomaly flagger for money-moving operations.
 *  - `windowMs` / `max`           : cap on *all* state-changing ops per actor per window.
 *  - `moneyWindowMs` / `moneyMax` : stricter cap on money-moving ops (pay/withdraw/top-up/fund).
 *  - `anomalyAmount`              : if > 0, a single amount at/above it is flagged (not blocked).
 *  - `burstN` within `burstMs`    : a rapid run of money ops is flagged (not blocked).
 * Flags don't reject — they annotate the audit record and the response so an operator notices.
 */
function createRateLimiter(opts = {}) {
  const windowMs = Number(opts.windowMs) || 60_000;
  const max = Number(opts.max) || 40;
  const moneyWindowMs = Number(opts.moneyWindowMs) || 60_000;
  const moneyMax = Number(opts.moneyMax) || 12;
  const anomalyAmount = BigInt(opts.anomalyAmount != null ? String(opts.anomalyAmount) : "0");
  const burstN = Number(opts.burstN) || 5;
  const burstMs = Number(opts.burstMs) || 10_000;

  const hits = new Map(); // key -> { all: number[], money: number[] }

  function prune(arr, horizon) {
    while (arr.length && arr[0] < horizon) arr.shift();
  }

  /** @returns {{flags: string[]}} ; throws httpError(429) when a hard cap is exceeded. */
  function check(key, { money = false, amount = null, op = "" } = {}) {
    const now = Date.now();
    const e = hits.get(key) || { all: [], money: [] };
    prune(e.all, now - windowMs);
    prune(e.money, now - moneyWindowMs);

    if (e.all.length >= max) {
      hits.set(key, e);
      throw httpError(429, "Too many operations — slow down and try again shortly.", { rateLimited: true });
    }
    if (money && e.money.length >= moneyMax) {
      hits.set(key, e);
      throw httpError(429, "Too many fund-moving operations in a short time — paused for safety.", {
        rateLimited: true,
      });
    }

    const flags = [];
    if (money) {
      // burst: how many money ops in the last burstMs (this one included)
      const recentMoney = e.money.filter((t) => t >= now - burstMs).length + 1;
      if (recentMoney >= burstN) flags.push("burst");
      if (anomalyAmount > 0n && amount != null) {
        let amt = 0n;
        try {
          amt = BigInt(String(amount).trim() || "0");
        } catch {
          amt = 0n;
        }
        if (amt >= anomalyAmount) flags.push("large_amount");
      }
    }

    // record
    e.all.push(now);
    if (money) e.money.push(now);
    hits.set(key, e);
    return { flags };
  }

  return { check };
}

/**
 * Build the authorizer.
 * @param {object} cfg
 * @param {Record<string, {tier:string, highRisk?:boolean, allowWhenFrozen?:boolean, run:Function}>} cfg.ops
 * @param {{append:Function}} cfg.audit
 * @param {() => boolean} cfg.isFrozen        - current global kill-switch state
 * @param {{required:() => boolean, verify:(token:string, op:string, args?:object)=>boolean}} cfg.stepUp
 * @param {{check:Function}} [cfg.rate]
 */
function createAuthorizer({ ops, audit, isFrozen, stepUp, rate }) {
  if (!ops || typeof ops !== "object") throw new Error("authorizer: ops registry is required");
  rate = rate || createRateLimiter();

  function tierOf(name) {
    const op = ops[name];
    return op ? op.tier : null;
  }

  /**
   * Run a whitelisted operation under policy. `ctx` carries request identity:
   *   { actor, ip, sid, confirmToken }   (actor/ip/sid for the audit trail; confirmToken for step-up)
   * `ctx.meta` is a scratch object the op may populate (e.g. txId, resolved amount) for the audit line.
   */
  async function execute(name, args = {}, ctx = {}) {
    const op = ops[name];
    const actor = ctx.actor || "anon";
    const base = { actor, ip: ctx.ip || "?", sid: ctx.sid || null, op: name };

    // 1. whitelist — refuse anything not registered.
    if (!op) {
      audit.append({ ...base, tier: "?", status: "denied", reason: "unknown_operation" });
      throw httpError(403, "Operation not permitted.");
    }

    const stateChanging = op.tier !== TIERS.READ;

    // Reads bypass the gauntlet (no freeze, no rate limit, no step-up, no audit noise).
    if (!stateChanging) {
      return await op.run(args, ctx);
    }

    // 2. kill switch — a frozen dashboard refuses every money/admin op (except the unfreeze itself).
    if (isFrozen() && !op.allowWhenFrozen) {
      audit.append({ ...base, tier: op.tier, status: "denied", reason: "frozen" });
      throw httpError(423, "The dashboard is frozen (emergency stop). Unfreeze it to move funds.", {
        frozen: true,
      });
    }

    // 3. rate limit + anomaly flags (money ops are throttled hardest).
    let flags = [];
    try {
      const money = op.tier === TIERS.MONEY;
      const amount = args && (args.amount != null ? args.amount : args.fund != null ? args.fund : null);
      ({ flags } = rate.check(ctx.rateKey || actor, { money, amount, op: name }));
    } catch (e) {
      audit.append({ ...base, tier: op.tier, status: "denied", reason: "rate_limited" });
      throw e;
    }

    // 4. step-up confirmation for high-risk ops, independent of the login session.
    if (op.highRisk && stepUp && stepUp.required()) {
      // Pass the operation's actual arguments so the confirm token can be verified as bound to THESE
      // funding parameters (amount, payee, caps, budget), not merely to the operation name.
      const okToken = ctx.confirmToken && stepUp.verify(ctx.confirmToken, name, args);
      if (!okToken) {
        audit.append({ ...base, tier: op.tier, status: "denied", reason: "confirmation_required" });
        throw httpError(401, "This action needs a fresh confirmation.", { confirmRequired: true, op: name });
      }
    }

    // 4b. DURABLE audit for HIGH-RISK fund ops: record the ATTEMPT *before* touching the chain, and
    // fsync it. If we cannot durably persist it, we REFUSE the action — a money operation we cannot
    // record is one we do not perform. This makes the audit entry part of the operation, so an audit
    // outage fails the op loudly instead of letting an unrecorded fund move slip through. (Low-risk
    // and read ops keep the best-effort append below.) The strict writer is used when the audit sink
    // provides one; otherwise we fall back so a minimal audit object still works.
    const strict = typeof audit.appendStrict === "function" ? audit.appendStrict : audit.append;
    if (op.highRisk) {
      try {
        strict({ ...base, tier: op.tier, highRisk: true, status: "attempt", flags, params: args });
      } catch (e) {
        audit.append({ ...base, tier: op.tier, status: "denied", reason: "audit_unavailable" }); // best-effort breadcrumb
        throw httpError(500, "Cannot durably record this action in the audit log; refusing to perform it.", {
          auditUnavailable: true,
        });
      }
    }

    // 5. run + audit (success and failure both leave a record). For high-risk ops the outcome record
    // is written durably too; the pre-op `attempt` record above is the authoritative durable trace, so
    // if an outcome write fails *after* an irreversible chain op we log loudly rather than falsely
    // reporting failure for something the chain already finalized.
    const recordOutcome = (entry) => {
      if (!op.highRisk) return audit.append(entry);
      try {
        strict(entry);
      } catch (e) {
        console.error("warn: could not durably write high-risk audit outcome (attempt record stands):", e.message);
        audit.append(entry);
      }
    };
    ctx.meta = ctx.meta || {};
    try {
      const result = await op.run(args, ctx);
      recordOutcome({
        ...base,
        tier: op.tier,
        highRisk: Boolean(op.highRisk),
        status: "ok",
        flags,
        params: ctx.meta.params !== undefined ? ctx.meta.params : args,
        txId: ctx.meta.txId || null,
        detail: ctx.meta.detail || undefined,
      });
      if (flags.length) {
        // surface the flag to the caller without changing the result shape it expects
        if (result && typeof result === "object" && !Array.isArray(result)) result._flags = flags;
      }
      return result;
    } catch (err) {
      recordOutcome({
        ...base,
        tier: op.tier,
        highRisk: Boolean(op.highRisk),
        status: "error",
        flags,
        params: ctx.meta.params !== undefined ? ctx.meta.params : args,
        error: err && err.message ? err.message : String(err),
        httpStatus: err && err.status ? err.status : 500,
      });
      throw err;
    }
  }

  return { execute, tierOf, TIERS };
}

module.exports = { createAuthorizer, createRateLimiter, TIERS };
