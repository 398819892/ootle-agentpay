# Security notes & audit-prep / 安全说明与审计准备

Read this before pitching, deploying to a value-bearing network, or commissioning an audit.

## Trust model — what the chain enforces

Enforced **on chain** (a compromised client cannot bypass):

- **Escrow**: funds only leave via `release` (payer or preimage), `refund` (payer, after timeout),
  or `resolve` (arbiter, after dispute). Double-release is blocked by the state machine. Fees are
  computed on chain.
- **AgentBudget**: per-tx cap, rolling daily cap, merchant whitelist, global revoke, and **per-session
  revoke** are all enforced in the template. Owner methods are badge-gated (`rule!(resource(owner_badge))`).
  `pay`/`pay_via_escrow` are `allow_all` at the component level **by design** and self-enforce the agent
  badge inside the method: the caller must pass a proof of an agent-badge session token, which the
  method validates (`assert_resource` + a per-session revoke check) before moving funds — a fixed
  component access rule can't identify *which* session is paying, so the gate lives in the method. All
  session badges are tokens of one agent-badge resource. The randomised stress test
  (`examples/stress_devnet.py`) checks accept-iff-allowed over random inputs.
- **OtcBoard**: listing bond, max-listing-amount cap, and arbiter whitelist are enforced at `list`;
  settlement authorises against the recorded seller/buyer/arbiter identities. An optional
  **arbiter stake** (set by the owner via `set_arbiter_stake`) is required before an arbiter may
  `resolve`, and the owner can `slash_arbiter` a misbehaving arbiter's stake to the treasury. The
  stake is **locked while a dispute names that arbiter**: `unstake_arbiter` is rejected if the caller
  is the arbiter on any listing in `Disputed`, so an arbiter cannot dodge a slash by withdrawing
  their collateral the moment a dispute lands (tested).

### OTC is trust-minimised, NOT a trustless atomic swap

The OTC flow settles an **off-chain payment** (fiat or another chain), so it cannot be a trustless
atomic swap — the chain has no way to observe that the buyer actually paid. Read `confirm(preimage?)`
precisely:

- The optional **hashlock preimage is only a cryptographic condition, not a receipt.** Revealing a
  preimage whose SHA-256 matches `hashlock` releases the asset; it proves the releaser *knows a
  secret*, **not** that any off-chain/fiat payment arrived. Whoever holds the preimage can trigger
  release **before** (or without ever) paying, so a seller who hands the preimage over early, or
  whose preimage leaks, can be released against without being paid.
- Without a hashlock, release is the **seller's** `confirm` — i.e. the seller voluntarily
  acknowledging payment. That is a trust assumption on the seller's honesty, backed only by the
  dispute → arbiter path.
- **Net:** OTC safety rests on off-chain-payment trust **plus** the arbiter (and the arbiter's
  stake), not on atomicity. Present it to users as an *escrow with human arbitration*, never as a
  trustless swap. "Privacy" here is scoped and known (balances and amounts are public, see
  limitation 1); it is not anonymity.

Enforced **off chain only** (client-side, advisory):

- The SDK's `_precheck` and the phase-1 `PolicyEngine` — a friendly early error. The chain is the
  source of truth; never rely on the client for a limit.
- Invoice expiry and the memo codec (`agentpay.invoice`). A memo is public metadata, not a secret.

## Known limitations

1. **Confidential amounts can't be range-checked inside a template → balances are public.** The
   engine can't read a hidden confidential value, so hard caps only work on a *plaintext countable*
   resource (spike conclusion, 方案 a). **Be explicit with users: the budget/escrow balance and every
   payment amount are visible on chain.** Only the final settlement could later be routed through a
   confidential resource. A confidential-balance variant would need a "revealed amount + range proof"
   scheme (mid-term) or stronger on-chain amount checks from the Ootle (long-term) — out of scope now.
2. **Time is epoch-granular (~30 min), and there is no on-chain scheduler.** Timeouts and the "daily"
   window are epoch windows, not wall-clock; document this to users. No sub-epoch deadlines. Crucially,
   the AgentBudget "periodic allowance" is **lazy, not timed**: the per-window spend counter resets on
   the first `pay` of a new window, and nothing on chain fires on a schedule. A recurring top-up or a
   subscription-style charge **must be driven by the owner or an external keeper** calling `top_up`
   (which is open precisely so a keeper can) — do not present it to users as an automatic/guaranteed
   recurring payment. The chain enforces the *caps*; it does not *initiate* anything.
3. **Escrow payer identity = whoever signs `new`.** This is why `OtcBoard` embeds its own escrow
   logic with explicit seller/buyer public keys rather than opening a standalone `Escrow` on the
   buyer's behalf. Anyone composing `Escrow::new` from another template must account for this.
4. **Fees are always public** (plaintext payout + a `std.vault.pay_fee` event). Even over a
   confidential resource, the revealed fee leaks that *a* payment happened and its size.
5. **Arbiter is trusted to resolve fairly, now with skin in the game.** `resolve` can still split
   arbitrarily within the escrowed amount, so a dishonest arbiter can misjudge a single case.
   Mitigations: the arbiter whitelist, **plus an optional arbiter stake** — the owner sets a required
   stake (`set_arbiter_stake`), an arbiter must post it (`stake_arbiter`) before they can `resolve`,
   and the owner can `slash_arbiter` it to the treasury. This is **owner-governed**, not trustless:
   it penalises a bad arbiter but still trusts the owner to slash correctly. Trustless upgrades
   (multi-arbiter majority vote, an appeals round, automatic slash-on-overturn) remain future work.
6. **Bond is returned, not slashed.** The listing bond deters spam (capital lock per listing) but is
   not slashed on a dispute lost by the seller — slashing-on-outcome is a future refinement.
7. **Devnet demo simplifications (not in the templates):** the Python demos let one key play several
   roles because the wallet daemon signs with its default account; role separation is proven by the
   templates' cargo tests (distinct accounts), not by the demos.

## What to tell end users (plain language) / 对最终用户的披露

非技术用户在用之前应当知道的三件事(也应显示在任何前端里):

1. **余额是公开的。** 预算钱包/托管里的金额和每一笔支付,别人都能在链上看到。它保证的是"花不超限"
   (链上硬限额),不是"花了多少别人不知道"。真正需要隐私的支付要另走保密通道(路线图)。
2. **时间按 ~30 分钟的 epoch 计。** "每日限额"其实是"约 24 小时的 epoch 窗口","超时退款"只能精确到
   ~30 分钟。别按自然日/精确到分钟来理解。
3. **仲裁人是被信任方(但有质押)。** 争议由指定仲裁人裁决,他能在托管金额内任意分配。平台靠白名单
   + 质押/罚没来约束他,但一次具体裁决仍依赖其诚实。大额交易请选信誉好、质押高的仲裁人。

## Attack surface to review in an audit

- Re-entrancy / cross-component call ordering around `invoke("deposit", …)` (buckets must be
  deposited or burned before the transaction ends; empty-bucket guards).
- Integer handling in fee/split math (`amount * fee_bps / 10000`, `total − to_payee`): truncation,
  negative inputs (`resolve`/`set_params` assert non-negative), overflow.
- State-machine completeness: every method asserts the expected state; no path leaves funds stuck or
  double-spent. Confirm removed/kept map entries don't orphan vault substates.
- Access rules vs internal checks: badge-gated methods (`rule!(resource(...))`) and identity checks
  (`CallerContext`) — confirm no method is unintentionally `allow_all`. **Note the deliberate
  exception:** `AgentBudget::pay`/`pay_via_escrow` are `allow_all` and enforce the agent badge *in the
  method body* via the `Proof` argument (`assert_resource` + per-session revoke set). Audit that this
  self-check cannot be bypassed (e.g. a proof of the wrong resource, an empty proof, or a stale
  `revoked_sessions` read) and that `top_up` being open cannot harm the budget (it only adds funds of
  the vault's own resource).
- Hashlock: `intrinsics::hash_sha256` preimage check; preimage is revealed on release (expected).

## Audit-prep checklist

- [ ] Freeze template versions and record their published addresses + metadata hashes.
- [ ] Run `cargo test` for all three templates (49 tests — Escrow 17, AgentBudget 14, OtcBoard 18)
      and the SDK (`pytest`) in CI. Note the SDK suite does **not** cover the experimental
      `ootle_chain.OotlePyChain` adapter (unverified against a live indexer; has `NotImplementedError`
      stubs) — see `sdk/README.md`.
- [ ] Run `examples/stress_devnet.py` with a high round count against a soak swarm.
- [ ] Review the 7 known limitations above with the auditor; decide which are acceptable for mainnet.
- [x] Owner-governed arbiter stake + slash implemented (`set_arbiter_stake`/`stake_arbiter`/
      `slash_arbiter`), with the stake **locked against `unstake_arbiter` while a dispute names the
      arbiter** so a slash can't be dodged (tested). Still to do for high value: trustless
      multi-arbiter vote / appeals / auto-slash-on-overturn, and listing-bond slashing-on-outcome.
- [ ] Legal/compliance review for the OTC product (KYC/AML varies by jurisdiction) before launch.
- [ ] Deploy to a public testnet (esmeralda) once test funds are available (the public faucet was
      empty during development; funding needs an L1 Minotari burn — see docs/devnet.md).
