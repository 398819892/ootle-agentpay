# `scripts/` — helper, demo & deploy scripts

Reproducible helpers for running this project against a **live Tari Ootle chain** — a local
swarm (wallet daemon JSON-RPC on `127.0.0.1:12010`, see [`../docs/devnet.md`](../docs/devnet.md))
or the public **esmeralda** testnet (walletd on `127.0.0.1:5100`, see
[`../docs/esmeralda.md`](../docs/esmeralda.md)).

All Python here is **stdlib-only** and run from the repo root, e.g. `python scripts/demo_zh.py`.
Dev happens on **WSL Ubuntu**; the shell scripts assume a swarm laid out under `/root/ootle/…`
(the layout in `docs/devnet.md`). Most publish helpers mint an Admin JWT from the `auth=none`
wallet daemon themselves — nothing here stores a credential.

> Prefer the top-level `make` targets (see [`../Makefile`](../Makefile)) over calling these
> directly — `make demo`, `make publish-local`, `make dashboard`, etc. wrap the common ones.

---

## Demos & interactive console

| Script | What it does |
|---|---|
| `demo_zh.py` | 一键中文讲解:terminal walkthrough of the on-chain AgentPay limits (per-tx cap, daily cap, whitelist, revoke). `--auto` runs non-stop, `--otc` shows the OTC flow instead. Uses the repo SDK (`sdk/src`). |
| `console.py` + `console.html` | Local web console (`http://127.0.0.1:8700`): click buttons, watch balances / limits change on chain in real time. Wraps the SDK's `OnChainBudget`. **Keep both files together** — `console.py` serves `console.html` from the same dir. |
| `otc_demo.py` | On-chain OtcBoard flow (list → take → confirm) against the swarm. Self-provisions the buyer / treasury accounts it needs. |
| `otc_stake_demo.py <OtcBoard template addr>` | On-chain demo of the OtcBoard arbiter **stake + slash** path. Pass the published template address as arg 1 or via `OTC_TEMPLATE`. |
| `call-escrow.py` | Real on-chain verification of the Escrow template on the swarm (instantiate → release, assert balances move). Uses hard-coded localnet component/template addresses from the baseline deploy. |

## Publish (local swarm)

Each mints an Admin token from the local walletd (`:12010`, `auth=none`) and runs
`tari -n localnet publish …`. They `cd` into the template source under `/root/ootle/…` on the
dev box — adjust those paths to your checkout (or publish the in-repo `templates/<name>`).

| Script | Publishes |
|---|---|
| `publish-escrow.sh` | the Escrow template |
| `publish-agent.sh` | the AgentBudget template |
| `publish-otc.sh` | the OtcBoard template |
| `publish.sh` | the reference `guessing_game` example (smoke-test of the publish path) |

## Esmeralda (public testnet)

Funding an esmeralda account is non-trivial: the account starts at 0 balance and off chain, so it
can't pay its own fee — the fee has to come from the faucet coins claimed in the **same**
transaction, which the walletd manifest DSL can't express. Hence a small Rust transaction builder.
See [`../docs/esmeralda.md`](../docs/esmeralda.md) for the full method.

| Script | What it does |
|---|---|
| `esme-fund/` | Rust helper (Cargo crate) that builds the raw `UnsignedTransaction` JSON (claim → pay-fee-from-bucket → create/fund account) and prints it. Build in WSL with the walletd's crate versions. |
| `esme_fund_submit.py` | Drives the funding: auth → read current epoch → run `esme-fund` → `transactions.submit_dry_run` (default) or `transactions.submit` (`--submit`); `--fee=N`. |
| `esme_token.py` | Prints a fresh Admin JWT minted from the esmeralda walletd (`:5100`, `auth=none`). Handy as the token source for the publish retry loop. |
| `esme_publish_retry.sh <template…>` | Publishes template(s) to esmeralda, retrying on transient indexer errors and stopping on real rejects. **Note:** it reads a token-printing helper via a hard-coded `TP=…/token.py` scratchpad path — point `TP` at `esme_token.py` (or your own) before running. |
| `esme_probe.py` | One-shot probe: checks whether the esmeralda walletd accepts `credentials: None` and dry-runs a faucet claim. Diagnostic / reference. |

## Dev helpers

| Script | What it does |
|---|---|
| `walletd-wrapper.sh` | Wrapper that injects `--override-keyring-password` into `tari_ootle_walletd` (WSL has no OS keyring). Install it as described in `docs/devnet.md` §2. |
| `verify.sh` | Post-publish sanity check: account balance + `get_substate` for a published template via the indexer. Edit the `TPL` hash for the template you published. |

---

### What was removed

A batch of one-off debugging artifacts was deleted during repo-hygiene cleanup (they were used
once to discover RPC shapes / fund during bring-up and are superseded by the docs and the helpers
above): `probe-methods.sh`, `probe-submit{,2,3,4}.sh` (RPC param-shape discovery),
`fund{,2,3}.sh`, `make-accounts.sh`, `setup-account.sh`, `rpc.sh` (ad-hoc funding / account
setup — now in `docs/devnet.md`), and `proto-budget.py` (AgentBudget prototype — superseded by
`sdk/examples/demo_devnet.py` + `console.py`).
