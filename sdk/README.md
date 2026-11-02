# ootle-agentpay

Budget-capped, **chain-enforced** payments for AI agents on Tari's L2 (Ootle). Amounts are **public**
on chain (see `../docs/security.md`); what the chain guarantees is "cannot spend over the limits",
not "nobody can see the spend".

**Status.** The supported path is `agentpay.onchain` (`OnChainBudget` / `WalletdClient`): a
stdlib-only JSON-RPC adapter that drives the `AgentBudget` template through a wallet daemon, run
end-to-end on a local swarm and on the esmeralda testnet. The test suite (`pytest -q`) covers it
plus the chain-agnostic helpers. Two modules are **experimental and not part of the supported
surface** (they are not in the package's `__all__`; import them from their own modules only if you
knowingly want them):

| Module | What it is | Why it is experimental |
|---|---|---|
| `agentpay.budget` (`BudgetManager` / `AgentWallet`) | the original **phase-1** model: throw-away session keys, limits checked **client-side** | its per-tx cap / allowlist / expiry can be ignored by a compromised agent process; only the funded amount is a hard ceiling; it has never run against a live chain (offline `FakeChain` only) |
| `agentpay.ootle_chain.OotlePyChain` | a `ChainPort` on `ootle-py` | written against `ootle-py` 0.2.0's documented API, **never run against a live indexer**, still contains `NotImplementedError` stubs; not covered by any test |

`agentpay.EXPERIMENTAL` lists those names. See `docs/00-api-notes.md` for verified vs. assumed, and
`docs/03-roadmap-onchain-conditions.md` for the phase 1 → phase 2 design history.

## The supported path: on-chain conditions via the `AgentBudget` template

`agentpay.onchain` backs a budget with the **`AgentBudget`** Ootle template (in this repo's sibling
`templates/agent_budget`), so the per-transaction cap, the rolling daily cap, the merchant whitelist
and the kill switch are enforced **on chain by the validator** — not by the client. The SDK's own
policy check is a friendly early error only; `OnChainBudget.would_reject()` asks the *validator*
(a dry run) and returns its reason, e.g. `Amount exceeds the per-transaction cap`. The invoice/memo
codec rides along as the (public, plaintext) on-chain memo, and a watcher rebuilds the local ledger
from the chain's `pay` events (`OnChainBudget.pay_events`). A budget can carry several agent
session badges (`issue_agent_badge`); the pay proof names **one** of them by id
(`OnChainBudget.session`, or `pay(..., session=...)`), which is what lets the owner
`revoke_session` a single agent/API key while the others keep paying.

Every value spliced into a transaction manifest (addresses, amounts, memo, session labels) is
strictly validated inside the manifest builders, so a crafted memo cannot inject manifest
instructions (`tests/test_onchain.py`). The budget is not bound to XTR: `open(..., resource=...)`
funds it in any plaintext resource and `top_up` reuses it.

```bash
# needs a running swarm with its wallet daemon on 127.0.0.1:12010 and the template published
PYTHONPATH=src python examples/demo_devnet.py [AGENT_BUDGET_TEMPLATE_ADDRESS]
PYTHONPATH=src python examples/stress_devnet.py 20     # randomised stress vs. a reference model
```

Non-custodial deployments (the agent holds its own key in its own walletd, with a least-privilege
token instead of `Admin`) are supported by `WalletdClient(token=..., permissions=...)` — see
`../docs/deployment-noncustodial.md`.

## Also included (chain-agnostic helpers)

- **Invoices + memo codec** (`agentpay.invoice`): `{"Message": "ap1|<invoice_id>|<agent_tag>"}` and
  an x402-*style* HTTP 402 challenge in our own `ootle-invoice-v1` scheme (standard x402 clients do
  not speak Ootle). The memo is public plaintext — never put a secret in it.
- **Merchant-side verification** (`agentpay.merchant`) with a replay guard.
- **A privacy linter** (`agentpay.privacy.assess`) that states, per flow, what still leaks (fees are
  always public; badge-variant coins expose holder lists; …) instead of overclaiming.
- **A batch-payout planner** (`agentpay.payout`) that splits payroll-style batches so one tx does not
  reveal headcount.
- **A phase-1 hash-lock "pay on delivery" approximation** (`agentpay.escrow`) — explicitly documented
  as not trustless. The real escrow is the on-chain `Escrow` template (`../templates/escrow`).

## Install

```bash
cd sdk
pip install -e .          # the on-chain adapter is stdlib-only; Python >= 3.9
pip install -e '.[dev]'   # + pytest / pytest-asyncio
pip install -e '.[ootle]' # optional: ootle-py (needs Python >= 3.13), only for tests/test_keys.py
```

## Run the tests (no network needed)

```bash
pytest -q                                   # with ootle-py installed
pytest -q --ignore=tests/test_keys.py       # without it (what the local CI does on Python 3.12)
```

## Run the offline demo (experimental phase-1 model, no network needed)

```bash
PYTHONPATH=src python examples/demo_offline.py
```

## Project layout

```
src/agentpay/
  onchain.py      SUPPORTED: OnChainBudget + WalletdClient (stdlib JSON-RPC + manifest builders)
  invoice.py      Invoice model, memo codec, x402-style challenge (de)serialisation
  merchant.py     merchant-side payment verification (match + replay guard)
  errors.py       exception hierarchy
  models.py       plain dataclasses (Identity, Session, SessionPolicy, ...)
  keys.py         deterministic session-key derivation (HKDF -> Ristretto scalar)
  policy.py       per-tx / session / daily caps, allowlist, expiry, rate limit (client-side engine)
  chain.py        ChainPort protocol (the seam the phase-1 model talks to)
  testing.py      FakeChain: in-memory ChainPort for tests / the offline demo
  store.py        session persistence (memory / JSON file)
  compliance.py   issuer-freeze / badge-registration guard
  payout.py       batch payout planner
  privacy.py      privacy linter
  escrow.py       phase-1 hash-lock "pay on delivery" approximation
  budget.py       EXPERIMENTAL: BudgetManager (owner) + AgentWallet (agent), phase-1 model
  ootle_chain.py  EXPERIMENTAL: ChainPort on ootle-py -- never run against a live indexer
tests/            pytest suite (onchain adapter + helpers on FakeChain; test_keys needs ootle-py);
                  does NOT exercise ootle_chain.py
examples/
  demo_devnet.py  end-to-end against a live swarm (the supported path)
  stress_devnet.py randomised accept-iff-allowed stress against a live swarm
  demo_offline.py walkthrough of the experimental phase-1 model on FakeChain
docs/
  00-api-notes.md      verified vs. assumed ootle-py / stable-coin API surface
  03-roadmap-onchain-conditions.md   phase 1 vs. phase 2 design (history)
```

## Honesty notes (please read before pitching this to anyone)

1. **The on-chain path is real; the phase-1 model is not a security boundary.** `agentpay.onchain`
   has made confirmed payments on a local swarm and on esmeralda, and its limits are validator-
   enforced. `agentpay.budget`'s limits are client-side only — a compromised agent holding the session
   key can spend the whole funded amount in one shot. Say this to customers explicitly.
2. **`ootle_chain.py` has never touched a live indexer.** Budget real time to get it working against
   LocalNet/esmeralda before relying on it — expect to fix method names, since `ootle-py` is pre-1.0.
3. **Amounts are public.** Hard limits can only be enforced on a plaintext, countable resource (the
   spike conclusion); the budget/escrow balance and every payment amount are visible on chain.
4. **The issuer of a stablecoin can freeze or recall funds regardless of anything this SDK does.**
   `compliance.py` surfaces this as a clear error, but it can't remove the issuer's power.
5. **Not audited.** See `../docs/security.md` for the trust model, known limitations and audit prep.
