# API notes (what's verified vs. assumed)

Verified by cloning and reading source on 2026-09-28:
- `tari-project/ootle-py` (pyproject version 0.2.0)
- `tari-project/stable-coin` (private_stable_coin templates, README + PR #32)

## Verified against real code

- `OotleSecretKey(network, owner_secret, view_secret)` takes two raw 32-byte Ristretto
  scalars; `.to_address()` round-trips through the vendored WASM bridge. **Ran this for
  real** (see `tests/test_keys.py`) — our HKDF-derived scalars produce valid addresses
  and are deterministic.
- `AsyncStealthTransfer`: `spend_stealth_input(owner_addr, commitment)`,
  `spend_revealed_input(component, amount)`, `to_stealth_output(Output(...))`,
  `to_revealed_output(amount)`, `pay_fee_from_revealed(amount)` / `pay_fee_from_stealth`,
  then `await .prepare()`.
- `Output` fields: `destination, amount, resource_address, resource_view_key, memo,
  pay_to, utxo_tag, minimum_value_promise`. `memo` is a raw dict mirroring Rust's `Memo`
  enum — `{"Message": "<=253 bytes utf-8"}` round-trips through the fixture in
  `ootle-py/tests/fixtures/stealth_unblind_vector.json`.
- `pay_to`: unit `{"StealthPublicKey": {}}` (default) or `{"AccessRule": {...}}` for a
  script-path output. **Not exercised end-to-end here** — see "Not verified" below.
- Recipient reads: `OotleWallet.decrypt_input_data(commitment, encrypted_input,
  sender_public_nonce=, view_secret=)` recovers `(mask, value, memo)`. The client-level
  `decrypt_owned_utxo` wraps this for the common "did I receive this UTXO" case.
- `AsyncOotleClient.connect(url, wallet=...)` is a **synchronous** factory — use
  `async with AsyncOotleClient.connect(...) as client:` directly, don't `await connect()`.
- `AsyncPendingTransaction.watch()` **raises** `TransactionRejectedError` /
  `TransactionTimeoutError` on failure; on success returns `TransactionOutcome` whose
  `.kind` is `"commit"` or `"only_fee_commit"` (not an `.is_commit` bool — we assumed
  that in an early draft and it's wrong).
- `private_stable_coin/issuer` template: mint/burn/recall/freeze/pause are admin-badge
  gated; deposits are gated by an `authorize_user_deposit` hook that requires a user
  badge in the recipient's account vault; `issuer-no-user-badge` drops that hook and its
  privacy tradeoffs are spelled out in the template's own README (holder enumeration,
  public registry of user_id -> account, deposits reveal destination, events name users).
- `transfer_fee` config in the stable-coin templates is stored but **not yet applied**
  (per the template's own README) — don't assume the coin enforces its own transfer fee.
- `pause` only blocks the four vault-deposit paths; it does **not** block transfers
  between holders, recall, freeze or burn (per the README) — verify this on your actual
  deployed instance before relying on it.

## Assumed / not verified — fix before depending on `ootle_chain.py`

- **Extracting change from a stealth transfer.** ootle-py's own example
  (`examples/stealth/spend_stealth_utxo.py`) reaches into the private `_transport`
  attribute to read the receipt diff, with a comment calling this "a known v1 gap". Our
  `OotlePyChain.send_stealth` returns `change=None` rather than guess at this.
- **`is_frozen` / `payee_can_receive`.** No public ootle-py helper answers either
  question directly; you need component-level read calls against your specific deployed
  `private_stable_coin` instance. Both raise `NotImplementedError` in `ootle_chain.py`.
- **Script-path (`AccessRule`) outputs** — i.e. the on-chain kill-switch / vesting design
  in docs/03 — are supported by the wire format (`pay_to: {"AccessRule": ...}`) but we
  have not built or tested one. Phase 1 of this SDK (see `budget.py`) works around this
  entirely by using per-session throw-away keys instead of on-chain conditions.
- **`ootle-py` is pre-1.0.** Its own CHANGELOG says the 0.x API may shift. Re-check this
  file against a newer version before upgrading the dependency.

## What this means for the SDK's design

Everything in `src/agentpay/*.py` except `ootle_chain.py` is chain-agnostic: it talks to
the `ChainPort` protocol (`chain.py`), tested against `testing.FakeChain`. Swapping in a
real, fully-verified `ootle_chain.py` should not require changing `budget.py`,
`policy.py`, `invoice.py`, `merchant.py`, `payout.py`, `privacy.py` or `escrow.py`.
