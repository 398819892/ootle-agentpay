---
name: contract-audit-pass
description: Systematic per-function authz/fund audit of the 3 templates + cross-product escrow-bypass tests
metadata:
  node_type: memory
  type: project
  originSessionId: e933168a-a49f-45e9-b516-7619b5b1333d
  modified: 2026-10-30T03:23:27.227Z
---

Systematic security re-audit of templates/{agent_budget,escrow,otc_board} (roadmap task 1). Walked every
state-changing fn for caller-binding / pre-state / fund-move / event + the 5 classic failure modes +
"can budget caps be bypassed via pay_via_escrow".

**Result: no NEW exploitable bug.** The real ones were already found/fixed earlier (see
[[security-correctness-pass]], [[payment-badge-proof-fix]]). This pass added verification, not fixes.

Deliverables: `docs/audit-notes.md` (per-fn tables + 3 documented trust/liveness limitations), plus 3
new test files pinning the gaps:
- `templates/otc_board/tests/authz.rs` — unauthorized cancel/reclaim/dispute/resolve + double-take all
  reject AND move nothing AND don't advance state (proved by legal next step still working).
- `templates/escrow/tests/authz.rs` — stranger-release-without-hashlock, resolve-when-not-disputed.
- `templates/agent_budget/tests/escrow_integration.rs` — **the key one**: per-tx/daily/whitelist/
  global-revoke/session-revoke all enforced on the `pay_via_escrow` route, daily counter SHARED between
  pay & pay_via_escrow (can't split to exceed cap), only the agent (escrow payer) can release, refund→owner.

Documented NON-bug limitations (design/trust, not fixed — would be features): L1 take has no taker bond
→ free listing griefing; L2 hashlock preimage ≠ payment receipt (OTC not trustless atomic swap); L3
slash-arbiter mid-dispute blocks that resolve until owner set_arbiter_stake(0) — funds NOT frozen,
recovery pinned by a test.

Local commits only, NOT pushed (user pushes to trigger CI). cargo baseline before: escrow 21 /
agent_budget 17 / otc_board 22 = 60.
