# Non-custodial deployment (the deployment that makes on-chain caps real)

AgentBudget enforces the per-transaction cap, rolling daily cap, merchant whitelist and kill switch
**on chain**, against the holder of the **agent badge**. Those limits are only a real security
boundary when the party they constrain — the agent — holds *its own* key, in *its own* environment,
and that key can touch *nothing else*.

This doc describes that deployment. It needs **no contract changes** (the AgentBudget template already
separates the owner badge from the agent badge, and the SDK already supports a separate
`agent_account`); it is a matter of **key separation, least-privilege walletd auth, and config**.

## Custodial vs non-custodial

| | Custodial (the dashboard default) | Non-custodial (this doc) |
|---|---|---|
| Keys | One walletd account holds the **owner badge + agent badge + funds** | Owner keeps owner badge + funds; **agent holds only the agent badge**, in its own walletd |
| walletd auth | `auth=none`, an **Admin** token | credentialed, **least-privilege** token (submit/read tx only) |
| What a compromised agent/server can do | Sign **anything** for the account — bypass the caps entirely | At most what the **agent badge + on-chain caps** allow; owner can `revoke` |
| On-chain caps are… | an API-layer convenience | the **actual** security boundary |

In the custodial setup the server operator is *not* constrained by the caps — it holds the owner
badge and an Admin token, so it can withdraw everything or sign outside the budget. That is fine for a
single-operator demo, but it is **not** what "chain-enforced limits" should mean.

## The boundary

The owner and the agent are **different keys on different walletds**:

- **Owner side** (you, offline/operator): holds the owner badge and the funding account. Opens the
  budget (`open`), sets caps, manages the whitelist, and is the only party that can `withdraw` or
  `revoke`. Never shipped to the agent.
- **Agent side** (the AI agent's own environment): its own walletd, its own account that holds **only
  the agent badge**, authed with a **least-privilege** token. It can call `pay` / `pay_via_escrow`
  within the caps — and nothing else. If it is fully compromised, the blast radius is exactly the
  caps (pay whitelisted merchants, ≤ per-tx, ≤ daily) until the owner revokes.

The agent badge is minted by the owner (`issue_agent_badge`) and handed to the agent's account; see
`templates/agent_budget` and the SDK's `issue_agent_badge(..., to_account=<agent account>)`.

## Least-privilege walletd auth

The SDK/TS clients no longer force an Admin token. Configure the agent's client with either a
pre-minted token or a narrow permission request:

**Python (`agentpay.onchain.WalletdClient`)**
```python
# Option A — a least-privilege token minted out-of-band for the agent's own walletd:
client = WalletdClient("http://agent-walletd:12010/json_rpc", token=AGENT_TOKEN).connect()

# Option B — let the client mint, but request only what submitting/reading a tx needs (never Admin):
client = WalletdClient(url, permissions=["TransactionSend", "TransactionGet"],
                       credentials=WALLET_CREDENTIAL).connect()
```

**TypeScript (`clients/ts` `WalletdClient`)**
```ts
const client = new WalletdClient(url, { token: AGENT_TOKEN });           // option A
// or: new WalletdClient(url, { permissions: ["TransactionSend", "TransactionGet"], credentials });
```

> The permission **names** are whatever your `tari_ootle_walletd` build defines for submitting and
> reading transactions — this client forwards them verbatim. Grant only those; **do not grant
> `Admin`**, which can sign for any account and defeats the whole point. Mint the agent's token with
> those permissions and a finite `duration`, out of band, and rotate it.

## Environment variables

The clients (and the MCP integration) read these, so deployment is config-only:

| Variable | Meaning |
|---|---|
| `AGENTPAY_WALLETD_URL` | the **agent's own** walletd endpoint |
| `AGENTPAY_WALLETD_TOKEN` | a pre-minted least-privilege bearer token for that walletd (TS also honors `OOTLE_WALLETD_TOKEN`) |
| `AGENTPAY_WALLETD_PERMISSIONS` | comma-separated permissions to request if no token is given (default `Admin` — override it) |
| `AGENTPAY_WALLETD_CREDENTIALS` | credential presented when minting (default `None`, for `auth=none`) |
| `AGENTPAY_AGENT_ACCOUNT` | the agent's account (holds only the agent badge) — keep it **≠** `AGENTPAY_OWNER_ACCOUNT` |
| `AGENTPAY_AGENT_BADGE` | the agent badge resource the owner issued to the agent |

The owner-side values (`AGENTPAY_OWNER_ACCOUNT`, the owner badge, the funding account) live only in the
owner's environment and are never set in the agent's.

## Checklist

- [ ] Owner opens the budget and issues an agent badge **to a separate agent account**.
- [ ] Agent runs against its **own** walletd (`AGENTPAY_WALLETD_URL`), not the owner's.
- [ ] Agent's token is **least-privilege** (submit/read tx), finite-lifetime, rotated — never `Admin`.
- [ ] `AGENTPAY_AGENT_ACCOUNT` ≠ owner account; the agent account holds **only** the agent badge.
- [ ] Owner badge, funding account and any Admin credential are **absent** from the agent environment.
- [ ] You can `revoke` (global) and `revoke_session` (per badge) from the owner side at any time.

## What this does NOT fix

A non-custodial agent is still bounded only by the caps you set — size `per_tx_cap` / `daily_cap`
sensibly, and remember the daily cap is a fixed window (see `docs/audit-notes.md` #5). The hosted
dashboard remains custodial by design; this path is for agents that hold their own keys.
