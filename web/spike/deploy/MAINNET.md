# AgentPay / AgentWallet — MainNet readiness & flip runbook

The single-origin non-custodial dApp (dashboard + in-page self-custody **AgentWallet**) is **network-parametric**:
one network NAME flows from the server env → `/api/status` → the wallet, and every browser-signed transaction
is scoped to that network and submitted to that network's indexer. Switching to the Ootle **MainNet** is a
config flip (+ a one-time template publish + real funds), not a code change.

## What's ready (code, verified on localnet 2026-11-11)

- **Network is configurable, not hardcoded.** `src/net-config.mjs` is the single source of truth
  (name → WASM `Network` enum + default indexer + whether a faucet exists). `src/sc-chain.mjs` builds every
  transaction for the configured network (`setNetwork()`), `src/inpage-wallet.mjs` resolves it from
  `/api/status`, `l2-wallet.mjs networkName()` and `sc-provider` cover all nets. Localnet is the default, so
  existing behavior is unchanged (regression-gated: `flow-a-sc` on-chain + 18/18 inpage + 34/34 provider tests).
- **MainNet is supported by the WASM.** `@tari-project/ootle` 0.14.0 has `Network.MainNet = 0`.
- **MainNet indexer is live.** `https://indexer-a.ootle.tari.com` (peer `-b`) —
  `GET /network → {"network":"mainnet","network_byte":0,...}` (verified 2026-11-11).
- **Faucet-less onboarding.** Main/stage/next have no faucet; the account address is derived from the key,
  so the wallet exposes it for **receiving** a real deposit (the first deposit creates the account on-chain).
- **Non-custodial server.** `AGENTPAY_CUSTODIAL=0` already makes the server hold no key and expose no signing
  surface (commit e2361c7). The mainnet drop-in keeps that.

## Prerequisites before the flip (external — not code)

1. **AgentBudget template published on MainNet.** The localnet template (`template_c4b5…`) is localnet-only.
   Publish the AgentBudget template to mainnet and capture its `template_…` address (see below). Needs the
   **compiled AgentBudget template `.wasm`** (build it from the template crate — it is NOT in this repo) and a
   funded mainnet account to pay the publish fee.
2. **Real TARI.** MainNet has no faucet. Burn XTM in **Tari Universe** → TARI arrives on L2 ~24h later. Use it
   to (a) pay the template publish fee and (b) fund any budget you open.
3. **Decide the merchant.** The whitelist is managed in-app, so a default `MERCHANT` is optional on mainnet.
4. **Security review items (recommended before real value).** Still open: [P1] origin isolation (the in-page
   wallet shares one execution context with the dApp — CSP + isTrusted raise the bar, true isolation = a
   separate-origin/extension signer), [P2] PBKDF2→argon2id + a higher passphrase floor. See the wallet
   security review. CSP + the script-driven-approval guard are already in.

## Step 1 — publish the AgentBudget template on MainNet

Build the template `.wasm`, fund a mainnet account (its owner/view secret + component), then:

```bash
# dry-run first (free; validates the tx shape) — run on the WSL ext4 build env
cd /root/agentpay-rebuild/spike
export NODE_OPTIONS="--experimental-wasm-modules --experimental-global-webcrypto"
AGENTPAY_NETWORK=mainnet \
TEMPLATE_WASM=/path/to/agent_budget.wasm \
PUBLISH_ACCOUNT=component_<funded-mainnet-account> \
PUBLISH_OWNER_HEX=<32-byte-hex> PUBLISH_VIEW_HEX=<32-byte-hex> \
node node/publish-template.mjs            # dry-run (PUBLISH_CONFIRM unset)

# looks right? publish for real:
… PUBLISH_CONFIRM=1 node node/publish-template.mjs
```

It prints the published `template_…` address. (Validate the flow first by dry-running against localnet/stagenet.)

## Step 2 — flip the service to MainNet

```bash
sudo install -D -m0644 web/spike/deploy/agentpay-wallet-mainnet.conf.example \
     /etc/systemd/system/agentpay-wallet.service.d/zz-mainnet.conf
sudo nano /etc/systemd/system/agentpay-wallet.service.d/zz-mainnet.conf   # set AGENT_TEMPLATE=<from step 1>
sudo systemctl daemon-reload && sudo systemctl restart agentpay-wallet
```

Verify:

```bash
curl -s http://127.0.0.1:16666/api/status   # network:"mainnet", indexer:indexer-a.ootle.tari.com, template:template_…
```

The CSP `connect-src` follows `INDEXER_URL` automatically, so the browser can reach the mainnet indexer.

## Step 3 — fund & use (per user, with real TARI)

1. Open the dApp, create/unlock the AgentWallet. On mainnet it shows the **receive address** (key-derived).
2. Send TARI to it (from your Universe burn payout, or any transfer). The first deposit creates the account.
3. Once the balance shows, open a budget (caps + fund) and connect — payments spend from the budget, you
   approve each, the browser signs, the L2 enforces the caps + whitelist. No faucet, no server key.

## Rollback

Remove the drop-in and restart (base unit = localnet); keep the previous `dist.bak-*` for a code rollback:

```bash
sudo rm /etc/systemd/system/agentpay-wallet.service.d/zz-mainnet.conf
sudo systemctl daemon-reload && sudo systemctl restart agentpay-wallet
```

## Status summary

| Item | State |
|---|---|
| Network-parametric code | ✅ done, localnet-regression-gated |
| MainNet enum / WASM | ✅ `Network.MainNet=0` in ootle 0.14 |
| MainNet indexer | ✅ `https://indexer-a.ootle.tari.com` (verified live) |
| AgentBudget template on mainnet | ⬜ publish after funding (Step 1; needs the template `.wasm`) |
| Real TARI (burn → 24h) | ⬜ user action in Tari Universe |
| Flip the service | ⬜ Step 2 (needs the template address) |
| [P1] origin isolation / [P2] argon2id | ⬜ recommended before real value |
