---
name: esmeralda-deploy-blocked
description: esmeralda 部署已完成 — 账户充值上链 + 三模板(escrow/agent_budget/otc_board)全部真实上链;附全套复现方法与踩坑
metadata:
  node_type: memory
  type: project
  originSessionId: e19fe688-4ea6-4c61-84ea-b404912b4961
  modified: 2026-10-26T01:07:53.174Z
---

esmeralda（公共测试网）真实部署 **已完成** ✅：账户充值上链 + 三个模板全部真实上链。详见 `F:\oolte\docs\esmeralda.md`。见 [[local-swarm-devnet]]。

## 已上链地址(真实)
- 账户 `dev` = `component_bfb548cf666300a09e374f8ad069e5b0688ce6418f7b9745734efdd22f1ce889`(已充值、已上链)。pubkey `2c049e88b8271733616f429dc51cfc34cc53c04cd6c300fbfb7a8f154f2df06f`,key_id `Derived{index:0,branch:"account"}`。充值 tx `bf15ebd8…`(Accepted)。
- **escrow** = `template_7de6ee2d11af98037cb408b47621ec79175b07866bcd57b3da2233c099b2be0e`
- **agent_budget** = `template_299d49bcace827cb86a8cdd9e6b1880783ae40a8a29ab28ba94b6b3ded6123a8`
- **otc_board** = `template_bafbe76e296da399e3b9e266c096fb46ccb0cc53b670b570279d7cff9a371b13`(substates.get 核实:Template 类型,author=本账户,at_epoch 12644,binary 含 "OtcBoard_main")

## 关键突破与踩坑(可复现,工具在 scripts/)
1. **绕过 manifest 充值**:raw `transactions.submit` 提交手工 `UnsignedTransaction`,fee_instructions 全套:`CallMethod(faucet,"claim",[pubkey]) → PutLastInstructionOutputOnWorkspace("claimed") → TakeFromBucket("claimed",fee,"fee_bucket") → PayFeeFromBucket("fee_bucket") → CreateAccount(owner_pk,bucket="claimed")`。PayFeeFromBucket 会吃掉整个桶(溢出归验证者),所以先 TakeFromBucket 切出手续费小桶,剩下存进新账户。faucet `claim(pubkey)` 每 key 给 1e9 µT。请求体 `{transaction:{"V1":..}, seal_signer, other_signers, signatures, detect_inputs, lock_ids}`。工具 `scripts/esme-fund/`(Rust)+ `scripts/esme_fund_submit.py`。
2. **必须开 trust**:公共 indexer 无法在 walletd 硬编码 30s 内做 `indexer_trust="verify"` 的 validator-set 证明验证。经操作者直接批准,config `[ootle_wallet_daemon]` 设 `indexer_trust = "trust"`(仅开发;仍真实 VN 执行)。
3. **发布**:`tari publish -n esmeralda -a dev -y --api-key <AdminJWT> --wallet-daemon-url http://127.0.0.1:5100/json_rpc`。坑:(a) 即使 auth=none,CLI 也要 `--api-key`(auth.request 铸 Admin JWT);(b) "发元数据到社区服务器?" 选 N;(c) **CLI 的 finalize 等待很短,submit 成功但等待超时会打印 "Waiting for transaction timed out!"(exit 1),但交易其实会落块**——不要当失败,用 `transactions.get_result` 或 `substates.get{template_<hash>}` 核实(重发已存在的模板会被拒 "Substate … already exists",这本身就证明在链上)。大交易(otc_board 237KiB)在公共 indexer 拥堵下 submit 成功率低,靠 `scripts/esme_publish_retry.sh` 持续重试撞窗口。

本地 swarm 仍是完整 devnet,所有模板也在其上真实验证(见 [[local-swarm-devnet]])。
