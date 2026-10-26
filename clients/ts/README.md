# @agentpay/client — TypeScript/JS client for AgentPay

A **TypeScript/JavaScript** client for [AgentPay](../../README.md) — the on-chain budget wallet
for AI agents on **Tari Ootle**. It is a 1:1 mirror of the Python SDK's on-chain adapter
([`sdk/src/agentpay/onchain.py`](../../sdk/src/agentpay/onchain.py)): same JSON-RPC methods, same
transaction-manifest strings, same event parsing.

It lets front-end / Node developers integrate AgentPay without Python.

## What it is (and isn't)

- **A thin JSON-RPC + manifest layer.** It talks to a running Tari Ootle **wallet daemon**
  (`walletd`) over JSON-RPC and drives the on-chain **AgentBudget** template by submitting
  transaction *manifests*. The daemon parses, **signs (with the referenced account) and pays the
  fee** — so there is **no client-side signing and no crypto dependency**.
- The per-transaction cap, rolling daily cap, merchant whitelist and kill switch are all enforced
  **on chain by the validator** — the agent's client cannot override them. `wouldReject()` asks the
  validator (via a dry run) and returns the chain's own reject reason.
- **Zero runtime dependencies.** Node 18+ ships a global `fetch`; that is all the client uses.
  TypeScript is only needed to *build*.

## Requirements

- **Node 18+** (for the built-in global `fetch`).
- A reachable Tari Ootle wallet daemon. By default the client targets the **local swarm**
  (`http://127.0.0.1:12010/json_rpc`, auth = none). See [`docs/devnet.md`](../../docs/devnet.md).

## Install & build

```bash
cd clients/ts
npm install      # dev-only: typescript + @types/node
npm run build    # tsc -> dist/
```

> **WSL note:** if your source lives on a Windows drive (`/mnt/f/...`) and you build from WSL,
> `npm install` over the DrvFs mount can occasionally corrupt `node_modules`. If `tsc` throws a
> `SyntaxError` from inside `node_modules/typescript`, copy `src/`, `package.json` and
> `tsconfig.json` to a native path (e.g. `~/build`), `npm install && npm run build` there, and copy
> `dist/` back. The checked-in `dist/` was built this way.

## Run the demo (against the local swarm)

The demo mirrors the Python `examples/demo_devnet.py`: open a budget → pay → chain rejects what the
rules forbid → revoke → withdraw → reconcile balances. It needs **no** `node_modules` (the client
has zero runtime deps).

```bash
npm run build        # once, to produce dist/
node dist/demo.js    # or: npm run demo
```

Real output against the live local swarm:

```
owner=component_9b4056f17545b0…  shop=component_1289d1b6783ce4…  scammer=component_be414b2227f98d…

== Owner opens an on-chain budget: 10000 funded, per-tx 1000, daily 1500, whitelist=[shop] ==
  budget component = component_8e94cdcc966e3c98e62f8e2e65be1fdba718c076e01abb62a013697032a47f59

== Agent pays an invoice to the shop (on chain, memo carries the invoice id) ==
  paid 700 — pay events read from chain: [{"amount":"700","memo":"ap1|…|shopper","merchant":"component_1289…","spent_in_window":"700"}]

== The chain REJECTS what the rules forbid (the VALIDATOR decides, not the client) ==
  over per-tx cap (1500 > 1000): rejected -> Amount exceeds the per-transaction cap
  non-whitelisted merchant:      rejected -> Merchant is not whitelisted

== A second real pay (700) brings spend to 1400; the next 700 would break the daily cap ==
  spent so far (daily cap 1500): 1400
  another 700 (1400 + 700 > 1500): rejected -> Amount exceeds the daily cap

== Owner revokes the agent (kill switch) — further pays fail on chain ==
  pay after revoke: rejected -> Agent has been revoked

== Owner withdraws the remaining balance ==
  withdrew 8600 back to owner

== Shop received: 1400 (expected 1400 = two 700 pays) ==
```

## Configuration

Everything is configurable via **constructor arguments** or **environment variables**. Defaults
target the local swarm.

| Env var | Meaning | Default |
|---|---|---|
| `AGENTPAY_WALLETD_URL` | wallet daemon JSON-RPC URL | `http://127.0.0.1:12010/json_rpc` |
| `AGENTPAY_BUDGET_TEMPLATE` | AgentBudget template address | `template_758d0c58…dec5b97` (localnet) |
| `AGENTPAY_OWNER_ACCOUNT` | funded owner account name | `default` |

The demo also accepts the template address as its first CLI arg: `node dist/demo.js template_…`.

### Pointing at esmeralda (public testnet)

The local swarm's `walletd` is forwarded; for esmeralda, point at its walletd and the esmeralda
AgentBudget template (see [`docs/esmeralda.md`](../../docs/esmeralda.md)):

```bash
AGENTPAY_WALLETD_URL=http://127.0.0.1:5100/json_rpc \
AGENTPAY_BUDGET_TEMPLATE=template_299d49bcace827cb86a8cdd9e6b1880783ae40a8a29ab28ba94b6b3ded6123a8 \
AGENTPAY_OWNER_ACCOUNT=dev \
node dist/demo.js
```

> On esmeralda the public faucet is empty, so merchants must already be on chain and the owner
> account (`dev`) must be funded. The client's `submitManifest` already retries **only** on
> transient public-indexer errors (connection / 30s timeouts), exactly like the Python SDK; a
> local swarm never triggers it.

## API

```ts
import { WalletdClient, OnChainBudget, newInvoiceId } from "@agentpay/client";

const c = await new WalletdClient(process.env.AGENTPAY_WALLETD_URL).connect(); // mint Admin token
const owner = await c.accountAddress("default");

// Owner opens an on-chain budget (funds it, sets the rules, receives both badges).
const budget = await new OnChainBudget(c, templateAddr, owner).open({
  fund: 10_000, perTxCap: 1_000, dailyCap: 1_500, epochsPerWindow: 10, whitelist: [shopAddr],
});

// Agent pays a whitelisted merchant (on chain). Ledger is rebuilt from the chain's pay events.
await budget.pay(shopAddr, 700, { memo: "ap1|inv123|shopper" });
await budget.payInvoice({ merchant: shopAddr, invoiceId: newInvoiceId(), amount: 700, agentTag: "shopper" });

// Ask the validator why a pay would fail, without committing (returns the on-chain reason, or null).
const reason = await budget.wouldReject(shopAddr, 1_500); // e.g. "Amount exceeds the per-transaction cap"

// Owner controls.
await budget.addMerchant(otherAddr);
await budget.revoke();             // kill switch
await budget.withdraw(8_600);      // reclaim remaining funds

console.log(budget.spent, budget.ledger);
```

| Class / method | Mirrors (Python) | Notes |
|---|---|---|
| `WalletdClient(url?)` / `.connect()` | `WalletdClient` / `.connect()` | mints an Admin token (auth=none) |
| `.accountAddress` / `.createAccount` / `.fund` / `.balance` | same | `fund` = localnet faucet (`create_free_test_coins`) |
| `.dryRun` / `.run` | same | `run` submits for real and polls `get_result` |
| `OnChainBudget(client, template, owner, {agentAccount?})` | `OnChainBudget` | agent defaults to owner (devnet) |
| `.open` / `.pay` / `.payInvoice` / `.wouldReject` / `.revoke` / `.withdraw` / `.addMerchant` | same | all `async` |
| `.readWindow()` | — (TS-only helper) | reads the live rolling-window status from chain |
| `WalletdClient.currentEpoch()` | — (TS-only helper) | current chain epoch (via `settings.get`) |
| `WalletdClient.getSubstate(id)` | — (TS-only helper) | read a component/resource substate (read-only) |
| `OnChainBudget.payEvents(result)` | `OnChainBudget.pay_events` | de-duplicated on-chain `pay` events |

All methods are `async` (the Python originals are synchronous). Errors derive from `AgentPayError`
(`ChainError`, `PolicyViolation`, `InvoiceError`).

## Spending window — the "daily cap" in human terms

The on-chain **daily cap is *not* a calendar day**. The AgentBudget template measures it over a
**rolling window of `epochsPerWindow` chain epochs** (an Ootle epoch is **≈30 min**), and the window
resets **lazily** — the spent counter is only zeroed on the next payment *after* the window has
elapsed (see `roll_window` in [`templates/agent_budget/src/lib.rs`](../../templates/agent_budget/src/lib.rs)).
That is correct but unintuitive, so the client ships a **read-only** helper that turns the raw
on-chain numbers into "X left this window, resets in ≈Y":

```ts
import { WalletdClient, OnChainBudget, windowStatus } from "@agentpay/client";

// 1) Straight from chain (recommended): reads the component substate + current epoch for you.
const w = await budget.readWindow();
//   { dailyCap, spentInWindow, remaining, epochsUntilReset, windowElapsed,
//     approxMinutesUntilReset, resetEta: "≈5h", epochMinutes: 30, ... }
console.log(`${w.remaining} left this window · resets ${w.resetEta}`);

// 2) Or compute it yourself from numbers you already have (pure, no chain access):
const status = windowStatus({
  dailyCap: 1_500, spentInWindow: 1_200,
  windowStartEpoch: 2, epochsPerWindow: 10,
  currentEpoch: await c.currentEpoch(),
});
```

`windowStatus()` is **pure computation** — no chain logic is touched and nothing is mutated. The
wall-clock figures are deliberately approximate (`≈`): epoch length is not fixed, so `resetEta` and
`approxMinutesUntilReset` are estimates, not guarantees. When the window has already elapsed,
`windowElapsed` is `true` and `remaining` is the **full cap** (the next payment resets the counter
first). `EPOCH_MINUTES` (30) is exported so callers can show the assumption.

## License

MIT.
