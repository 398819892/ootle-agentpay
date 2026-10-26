# Roadmap: from client-side limits to on-chain conditions

## Phase 1 (this repo, works today)

- Hard cap = funded amount, enforced by physics (an agent key can't spend a UTXO it
  wasn't given).
- Per-tx cap, session cap, daily cap, allowlist, expiry, rate limit: enforced by
  `PolicyEngine` in the SDK. **A compromised or malicious agent process that holds the
  session key can bypass all of these** — it can spend the full funded UTXO to anyone,
  once. This is stated plainly in `budget.py`'s module docstring; do not market phase 1
  as more than it is.
- Kill switch: works because the *owner* can always re-derive the session key
  (`BudgetManager.agent_identity`) and sweep. This does NOT require the agent to
  cooperate, and does not require an on-chain script path.

## Phase 2 (needs on-chain condition-tree outputs)

Fund each session as one stealth output whose `pay_to` is `{"AccessRule": ...}` with a
condition tree (two leaves):

```text
leaf A (agent spend): AccessRule(agent_pk) AND BeforeEpoch(session_expiry)
leaf B (owner reclaim): AccessRule(owner_pk)   [always available]
```

This moves the **expiry** and the **owner's reclaim right** on-chain: even if the agent
key leaks, an attacker cannot spend past the tree's own rules, and the owner's reclaim
path does not depend on re-deriving a session key correctly.

What phase 2 does **not** give you: a per-tx cap enforced on-chain while amounts stay
confidential. Every engine-side predicate we found in the docs looks at UTXO ownership /
timing, not at the confidential amount. A hard on-chain per-tx cap requires either (a)
revealing the amount at spend time, which defeats the point, or (b) an engine feature we
did not find evidence of as of 2026-09-28. Re-check the Ootle docs before promising this
to a customer.

## Phase 3 (multi-party session control)

Replace the single owner key with an m-of-n rule (owner device + a hosted policy
co-signer) on the reclaim leaf, so a customer isn't relying purely on "the vendor's
server holds the only sweep key". This is standard multisig, not Ootle-specific, but the
condition-tree plumbing above makes it a drop-in extension of leaf B.

## Why phase 1 ships first

Every piece needed for phase 1 exists and is verified in `ootle-py` 0.2.0 today (stealth
transfer, memo, recipient decrypt). Phase 2 needs either a typed template + `ootle-rs`,
or confirmation that condition trees can be expressed purely through the `pay_to:
AccessRule` field ootle-py's `Output` already carries — this needs testing against a
live indexer, which we do not have access to from this environment.
