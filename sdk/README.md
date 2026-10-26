# ootle-agentpay

Private, budget-capped stablecoin payments for AI agents on Tari's L2 (Ootle).

**Status: pre-alpha scaffold.** Business logic is implemented and tested (41 tests,
`pytest -q`) against an in-memory fake chain and against `ootle-py`'s real key-derivation
code. The real chain adapter (`agentpay.ootle_chain.OotlePyChain`) is written against
`ootle-py` 0.2.0's documented API but has **not** been run against a live indexer — see
`docs/00-api-notes.md` for exactly what is verified vs. assumed, and
`docs/03-roadmap-onchain-conditions.md` for what's phase 1 vs. phase 2.

## What this is

A Python SDK that lets an AI agent hold a **private, capped budget** in a confidential
stablecoin (the `private_stable_coin` templates in `tari-project/stable-coin`) and pay
per-invoice, with:

- **Session budgets.** The owner funds a throw-away session key with a fixed amount.
  That amount is a hard, on-chain ceiling — the agent can never spend more, no matter
  what the SDK-level policy says.
- **A kill switch that doesn't need the agent's cooperation.** The owner can always
  re-derive the session key from the master seed and sweep what's left.
- **A private, invoice-based payment flow** (`pay_invoice` / `Merchant.verify`) loosely
  modelled on x402, but using our own `ootle-stealth-v1` scheme — standard x402 clients
  do not speak Ootle.
- **A privacy linter** (`agentpay.privacy.assess`) that tells you, per flow, exactly what
  still leaks (fees are always public; badge-variant coins expose holder lists; etc.)
  instead of quietly overclaiming privacy.
- **A batch-payout planner** that splits payroll-style batches into several
  differently-sized, differently-timed transactions so one tx doesn't reveal headcount.
- **A phase-1 HTLC-flavoured escrow** for "pay on delivery" between agents — explicitly
  documented as not yet trustless (see `escrow.py`'s docstring).

## Why phase 1 doesn't need on-chain conditions

Ootle's condition-tree / script-path outputs (`AccessRule` in `pay_to`) would let you put
the per-tx cap and expiry *on chain*. We could not verify that surface end-to-end without
a live indexer, so phase 1 gets the important property — **a hard spending ceiling and an
owner-side kill switch** — from throw-away key derivation alone, which only needs the
stealth-transfer API we did verify. See `docs/03-roadmap-onchain-conditions.md`.

## Phase 2 is here: on-chain conditions via the `AgentBudget` template

The "phase 2" we couldn't verify above is now implemented and run end-to-end against a live
local network. `agentpay.onchain` (`OnChainBudget` / `WalletdClient`) backs a budget with the
**`AgentBudget`** Ootle template (in this repo's sibling `templates/agent_budget`), so the
per-transaction cap, the rolling daily cap, the merchant whitelist and the kill switch are all
enforced **on chain by the validator** — not by the client. The SDK's own policy check becomes a
friendly early error only; `OnChainBudget.would_reject()` shows the *validator* rejecting the same
payment with reasons like `Amount exceeds the per-transaction cap`. The invoice/memo codec is
unchanged (`invoice.encode_memo` rides along as the on-chain memo), and a watcher rebuilds the
local ledger from the chain's `pay` events (`OnChainBudget.pay_events`).

`agentpay.onchain` is **stdlib-only** (no `ootle-py`): it drives the template by submitting a
transaction manifest to a running Ootle wallet daemon over JSON-RPC. See
`examples/demo_devnet.py` for the full flow (open budget → pay invoice → over-cap / non-whitelist
/ over-daily / revoked payments all rejected on chain → owner withdraws), and the companion
`escrow` template for `pay_via_escrow` (pay-on-delivery). Related: `tests/test_onchain.py`.

```bash
# needs a running swarm with its wallet daemon on 127.0.0.1:12010 and the template published
PYTHONPATH=src python examples/demo_devnet.py [AGENT_BUDGET_TEMPLATE_ADDRESS]
```

## Install

```bash
cd ootle-agentpay
pip install -e .        # editable install; requires Python >= 3.13 (ootle-py's floor)
pip install -e '.[dev]' # + pytest
```

## Run the tests (no network needed)

```bash
pytest -q
```

## Run the offline demo (no network needed)

```bash
PYTHONPATH=src python examples/demo_offline.py
```

## Project layout

```
src/agentpay/
  errors.py       exception hierarchy
  models.py       plain dataclasses (Identity, Session, Invoice inputs, ...)
  keys.py         deterministic session-key derivation (HKDF -> Ristretto scalar)
  policy.py       per-tx / session / daily caps, allowlist, expiry, rate limit
  chain.py        ChainPort protocol -- the ONLY seam to the blockchain
  testing.py      FakeChain: in-memory ChainPort implementation for tests/demo
  ootle_chain.py  real ChainPort on ootle-py -- UNTESTED against a live indexer
  store.py        session persistence (memory / JSON file)
  compliance.py   issuer-freeze / badge-registration guard, fails with a readable error
  budget.py       BudgetManager (owner) + AgentWallet (agent) -- the core of phase 1
  invoice.py      Invoice model, memo codec, x402-style challenge (de)serialisation
  merchant.py     merchant-side payment verification (decrypt + match + replay guard)
  payout.py       batch payout planner (splits/jitters to avoid revealing headcount)
  privacy.py      privacy linter -- states what a given flow leaks, honestly
  escrow.py       phase-1 hash-lock "pay on delivery" approximation
tests/            41 tests, all passing, run against FakeChain + real ootle-py keys
examples/
  demo_offline.py end-to-end walkthrough against FakeChain
docs/
  00-api-notes.md      verified vs. assumed ootle-py / stable-coin API surface
  03-roadmap-onchain-conditions.md   phase 1 vs. phase 2 design
```

## Honesty notes (please read before pitching this to anyone)

1. **This has never touched a live Ootle indexer.** Everything is proven against a
   hand-rolled `FakeChain` that models ownership/double-spend/freeze/registration but not
   real cryptography. `keys.py` is the one module exercised against the real `ootle-py`
   WASM bridge. Budget a real "week 1" to get `ootle_chain.py` working against Esmeralda
   or LocalNet — expect to fix method names, since `ootle-py` is pre-1.0.
2. **Phase 1's policy limits (per-tx cap, allowlist, expiry) are client-side.** A
   compromised agent process holding the session key can ignore them and spend the whole
   funded amount in one shot. Only the funded amount itself is a hard, on-chain ceiling.
   Say this to customers explicitly.
3. **The issuer of the stablecoin can freeze or recall funds regardless of anything this
   SDK does.** `compliance.py` surfaces this as a clear error instead of a confusing
   chain rejection, but it can't remove the issuer's power, by design of the token.
4. **Privacy is partial, not absolute**, per `privacy.py`'s own linter output: fees are
   always public, and funding a session's fee reserve from a known owner account links
   owner to session unless you build a relayer (roadmapped, not built).
