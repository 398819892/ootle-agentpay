# Esmeralda (public testnet) deployment

**Date:** 2026-10-24 (funding + escrow/agent_budget); 2026-10-26 (otc_board confirmed)
**Status:** ✅ **COMPLETE** — account funded on chain, and **all three templates published on
chain** (escrow, agent_budget, otc_board). Publishing fought intermittent public-indexer
timeouts; `tari publish`'s short finalization wait meant some submits printed "timed out" while the
tx actually landed (confirmed by querying the substate afterwards).

---

## On-chain results

| Item | Address / id | State |
|------|--------------|-------|
| Account `dev` | `component_bfb548cf666300a09e374f8ad069e5b0688ce6418f7b9745734efdd22f1ce889` | **confirmed on chain, funded** |
| Funding tx | `bf15ebd8a9b39c15cf3c999878104a374d333ea654b50517fdfeb81fc6044f59` | Accepted |
| **escrow** template | `template_7de6ee2d11af98037cb408b47621ec79175b07866bcd57b3da2233c099b2be0e` | **published** |
| **agent_budget** template | `template_299d49bcace827cb86a8cdd9e6b1880783ae40a8a29ab28ba94b6b3ded6123a8` | **published** (tx `accc3704…`, Accepted) |
| **otc_board** template | `template_bafbe76e296da399e3b9e266c096fb46ccb0cc53b670b570279d7cff9a371b13` | **published** (author `2c049e88…`, at_epoch 12644; verified via `substates.get`) |

- Account pubkey: `2c049e88b8271733616f429dc51cfc34cc53c04cd6c300fbfb7a8f154f2df06f`,
  key_id `Derived{index:0, branch:"account"}`.
- Balance after funding: 999,994,000 µTari; after the escrow publish: ~998,731,074 µTari
  (publish fee ≈ 1.26 tTARI). Plenty remains for the other two publishes — funding is **not** the
  blocker.
- Network: esmeralda, network byte 38.

## How funding was done (the original blocker, solved)

The account had 0 balance and was not on chain, so it could not pay a fee. The fee had to come
from the faucet coins in the same transaction (`PayFeeFromBucket`), which the walletd manifest DSL
cannot express. Solution: build the raw `UnsignedTransaction` and submit via `transactions.submit`.

Transaction (all in the fee-instruction list, mirroring the wallet SDK's merged-fee-intent with a
revealed recipient):
`CallMethod(faucet,"claim",[pubkey]) → PutLastInstructionOutputOnWorkspace("claimed")
 → TakeFromBucket("claimed", fee, "fee_bucket") → PayFeeFromBucket("fee_bucket")
 → CreateAccount(owner_pk, bucket="claimed")`.
Note: `PayFeeFromBucket` consumes its *whole* bucket (overpayment kept by validators), so the fee
is split into its own small bucket via `TakeFromBucket` and the remainder in `"claimed"` funds the
new account. The Caravel faucet `claim(pubkey)` returns 1,000,000,000 µTari (1000 tTARI) per key.

Tooling (reproducible), in `scripts/`:
- `scripts/esme-fund/` — Rust helper that builds the UnsignedTransaction JSON
  (`cargo build` in WSL; deps from the local registry cache).
  Usage: `esme-fund <faucet_component> <owner_pubkey_hex> <network_byte> <max_epoch> <fee_microtari>`.
- `scripts/esme_fund_submit.py` — auth → epoch → build → submit (`--submit`) or dry-run; `--fee=N`.

## One required config change (operator-approved)

Default `indexer_trust = "verify"` could not work: the public esmeralda indexers do not serve the
validator-set proof verification within walletd's (hardcoded) 30s timeout. With the operator's
direct approval, `indexer_trust = "trust"` was set in
`~/.tari/ootle/esmeralda/config/config.toml` `[ootle_wallet_daemon]` (dev-only; transactions still
execute on real esmeralda validator nodes). This unblocked funding and the escrow publish.

## Publishing — command and the remaining blocker

Per template (WASM already built in the WSL dev box at `/root/ootle/<t>`):
```
TOK=$(python3 scripts/.../token.py)   # mint Admin JWT from walletd (auth=none)
cd /root/ootle/<t> && printf 'N\n' | script -qec \
  "tari publish -n esmeralda -a dev -y --api-key $TOK --wallet-daemon-url http://127.0.0.1:5100/json_rpc" out.log
```
- The `tari` CLI needs a bearer token via `--api-key` (or `TARI_WALLET_DAEMON_API_KEY`) even when
  walletd auth is `none` — mint an Admin JWT via `auth.request`.
- `-y` auto-confirms the publish; the "Publish metadata to community server?" prompt is answered
  **N** (nothing sent to a community server).

**Note on the publishing experience (public-infra congestion):** publishing is a large
transaction (escrow 150 KiB, agent_budget 209 KiB, otc_board 237 KiB WASM). The public esmeralda
indexers frequently failed its `submit_transaction` with `Indexer ... did not respond within 30s`
(plus occasional http2/connection errors), on both indexer-a and indexer-b — pure public-infra
congestion, not a problem with the templates, the account, or the submit path. Two important
gotchas, both of which bit us and are worth remembering:
- The `tari` CLI needs a bearer token via `--api-key` (mint an Admin JWT from `auth.request`) even
  when walletd auth is `none`; and it answers **N** to "Publish metadata to community server?".
- `tari publish`'s finalization wait is short. When the submit succeeds but the wait elapses, the
  CLI prints `Waiting for transaction timed out!` (exit 1) **even though the tx then lands on
  chain**. agent_budget and otc_board both landed this way. So after a "timed out" publish, do
  **not** assume failure — query `transactions.get_result{transaction_id}` (if you captured the
  id) or `substates.get{template_<hash>}` to check whether the template already exists. A later
  re-publish of an already-landed template is rejected with "Substate … already exists", which is
  itself proof it is on chain.
- Mechanics: retry the submit until it returns a tx id (`scripts/esme_publish_retry.sh <template>`),
  then confirm on chain as above. All three were confirmed this way.

---

## 真实 agent 集成 @ esmeralda（AgentPay × MCP,2026-10-26)

把 `integrations/agentpay_mcp/` 的**真 MCP 集成**指向 esmeralda 跑通:一个脚本化 AI agent 通过
真实 MCP 工具(`pay_merchant`/`get_budget_status`/`list_merchants`)花钱,每一笔的成败都由
**esmeralda 验证节点**裁决,拒绝理由原样经 MCP 回灌给 agent。

**接线方式(不改本地默认):** 三个环境变量
- `AGENTPAY_WALLETD_URL=http://127.0.0.1:5100/json_rpc`
- `AGENTPAY_BUDGET_TEMPLATE=template_299d49bcace827cb86a8cdd9e6b1880783ae40a8a29ab28ba94b6b3ded6123a8`(esmeralda 的 agent_budget)
- `AGENTPAY_OWNER_ACCOUNT=dev`(充过值的账户;demo 默认找名为 "default" 的账户,esmeralda 上叫 "dev")

跑法(Windows venv,localhost 转发到 WSL 的 walletd):
```
AGENTPAY_WALLETD_URL=http://127.0.0.1:5100/json_rpc \
AGENTPAY_BUDGET_TEMPLATE=template_299d49bc… AGENTPAY_OWNER_ACCOUNT=dev \
integrations/agentpay_mcp/.venv/Scripts/python integrations/agentpay_mcp/demo_agent.py --auto
```

**本次链上实体(esmeralda):**
| 角色 | 地址 |
|------|------|
| owner / agent = `dev` | `component_bfb548cf666300a09e374f8ad069e5b0688ce6418f7b9745734efdd22f1ce889` |
| 预算合约(本次实例) | `component_dcf58c0bff8571cd910637c7eb376890e657a82cfc7691df9e4e6808a1041b33` |
| 白名单商户 `shop` | `component_acff96b539e5c1f457eb7ee32238b5b478b5c293e9af00c9df7db58130d21e59` |
| 非白名单 `scammer` | `component_11711aeb007b31e8a19ac32de593c7962a52de4679d52019a8ee736d4403b9c5` |

**实跑结果(规则 单笔≤1000 · 日≤1500 · 白名单=[shop];拒绝理由均来自 esmeralda 验证节点):**
- 付 shop 700 → ✓(spent 700) · 付 1500 → ✗ `Amount exceeds the per-transaction cap`
- 付 scammer 100 → ✗ `Merchant is not whitelisted` · 再付 shop 700 → ✓(spent 1400)
- 再付 700 → ✗ `Amount exceeds the daily cap` · owner `revoke()` 上链 → 付 100 → ✗ `Agent has been revoked`
- owner 取回 8600(10000 − 已花 1400),shop 实际到账 1400,链上余额对平。

**esmeralda 适配踩坑:**
- 商户要能收款=要**上链**。esmeralda faucet 是空的(`create_free_test_coins` 不可用),改为从 `dev`
  用 `accounts.transfer`(发往商户 pubkey)转一点 XTR 把商户账户带上链;`scripts/`/scratchpad 有脚本。
- 公网 indexer 30s submit 超时对**小交易(付款/开预算)也偶发**。给 SDK 的 `WalletdClient` 提交加了
  **只针对网络瞬时错误**的重试(`sdk/src/agentpay/onchain.py` 的 `_submit_manifest`;本地 swarm 不触发,
  行为不变),demo 才能一轮跑完不中途崩。商户建账转账也带同样重试。
