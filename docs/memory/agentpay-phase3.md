---
name: agentpay-phase3
description: Phase 3 完成 — ootle-agentpay 接入链上 AgentBudget/Escrow（demo_devnet 活链跑通）
metadata:
  node_type: memory
  type: project
  originSessionId: 30883ce1-2799-45ad-b5e4-1944cba09e7d
  modified: 2026-10-22T01:26:16.194Z
---

Phase 3 完成。现有 Python 项目在 `F:\ootle-agentpay\ootle-agentpay`（嵌套一层）。给它加了**链上组件适配器**，devnet 全流程在活 swarm 上跑通。见 [[agent-budget-phase2]] [[local-swarm-devnet]]。

**新增文件：**
- `src/agentpay/onchain.py` — `WalletdClient`（walletd JSON-RPC，纯 stdlib，不依赖 ootle-py）+ `OnChainBudget`（驱动 AgentBudget 模板：open/pay/pay_invoice/revoke/withdraw/would_reject/pay_events）。用 `transactions.submit_manifest` 提交 manifest。
- `examples/demo_devnet.py` — 活链全流程：开预算→付发票→超单笔/非白名单/超日限/撤销后全被链拒→owner 取回。
- `tests/test_onchain.py` — 10 个单元测试（假 walletd，不需活链）。
- README 加「Phase 2 on-chain conditions」节；`__init__` 导出 OnChainBudget/WalletdClient/LedgerEntry。

**计划 4 要点全达成：** ①适配器调 AgentBudget（链上强制）②客户端 _precheck 仅提前报错、以链上为准（would_reject 走 dry_run 拿验证节点原因）③invoice.encode_memo 作 memo 原样上链 ④pay_events 从 tx 结果提取 pay 事件更新本地账本。

**跑法（WSL，Python 3.12，swarm 要在跑）：**
`cd /root/agentpay-proj && PYTHONPATH=src python3 examples/demo_devnet.py`（AgentBudget 模板地址 `template_758d0c58…`）。
测试：`PYTHONPATH=src python3 -m pytest -q --continue-on-collection-errors` → **46 passed**（含我的 10 个）。

**踩坑/注意：**
- 本机只有 Python 3.14（Win）/3.12（WSL），**没装 ootle-py**（需 ≥3.13）。所以 `tests/test_keys.py`（import ootle）收集失败，其余 46 个过。onchain 路径纯 stdlib，不受影响。
- manifest 关键：元组解构 `let (c,ob,ab)=AgentBudget::new(...)`；`drop_all_proofs!()` 是宏；badge proof 用 `acct.create_proof_for_resource(address!("resource_.."))`；Vec 参数 `[address!("..")]`；`amount!(N)`。
- 被拒的真实交易不 finalize（run() 会超时），所以"会不会被拒"用 dry_run（立即返回 error.message 含原因）。pay 事件在结果里出现两次，pay_events 按 payload 含 merchant+memo 匹配并去重。
- devnet 为签名简单让 owner 账户兼任 agent（持两 badge）；owner/agent 分离的正确性由 agent_budget 的 cargo 测试（独立账户）保证。
