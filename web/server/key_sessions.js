//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/** API key -> on-chain agent-session badge mapping (shared by the pay op and the /api/v1 routes). */
"use strict";

const { httpError } = require("./http_util");

function createKeySessions({ apiKeys, store, requireKeySessions: REQUIRE_KEY_SESSIONS }) {
  /**
   * The on-chain session state of an API key's badge, read from the budget snapshot (which follows
   * confirmed chain txs): `{ label, issued, revoked }`.
   */
  function keySessionInfo(budget, keyId) {
    const sessions = (budget && Array.isArray(budget.sessions) && budget.sessions) || [];
    let generation = 0;
    for (const s of sessions) generation = Math.max(generation, apiKeys.sessionGeneration(s, keyId));
    const label = apiKeys.sessionLabel(keyId, generation || 1);
    const issued = generation > 0;
    const revoked = issued && Array.isArray(budget.revokedSessions) && budget.revokedSessions.includes(label);
    return { label, issued, revoked, generation };
  }
  function keysWithSessions() {
    return apiKeys.list().map((k) => ({ ...k, session: keySessionInfo(store.budget, k.id) }));
  }
  /**
   * Which session badge an API key pays with: its own badge once issued, otherwise the budget's
   * "default" session, or a 403 when AGENTPAY_REQUIRE_KEY_SESSIONS forbids the fallback. Whether that
   * badge has been REVOKED is NOT decided here from the cached snapshot — the pay path asks the chain
   * with a dry-run right before submitting (S-7), so a just-revoked session is caught authoritatively
   * even if this process's cache is stale.
   */
  function keySession(b, keyId) {
    const info = keySessionInfo(b, keyId);
    if (info.issued) return info.label;
    if (REQUIRE_KEY_SESSIONS) {
      throw httpError(403, `API key ${JSON.stringify(keyId)} has no on-chain session badge yet; an admin must POST /api/v1/keys/${encodeURIComponent(keyId)}/session first.`, { session: null });
    }
    return "default";
  }

  return { keySessionInfo, keysWithSessions, keySession };
}

module.exports = { createKeySessions };
