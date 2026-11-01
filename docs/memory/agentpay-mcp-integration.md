---
name: agentpay-mcp-integration
description: "AgentPay 接真实 AI agent 框架的 MCP 集成 + 可一键演示\"付款被链限额拦住\""
metadata:
  node_type: memory
  type: project
  originSessionId: 13afa5de-af8c-4a8e-a0fd-aca54294a0a3
  modified: 2026-10-26T05:29:43.039Z
---

`integrations/agentpay_mcp/` 把 AgentPay 的链上预算钱包包成一个**真正的 MCP server**(FastMCP/stdio),
让任何 MCP 客户端(Claude Desktop/自写 agent)把它当工具用。是"真集成"不是又一个脚本:demo 作为真正的
MCP client 启 server、握手、list_tools、call_tool。2026-10-26 在本地 swarm(walletd :12010)上端到端跑通。

**结构(都复用现成 SDK,没动 `sdk/src/agentpay/` 和 `templates/`):**
- `agentpay_mcp/backend.py` — 薄胶水层包 `agentpay.onchain.OnChainBudget`:`open_budget`(owner,持 owner badge)/
  `attach_wallet`(agent,只给 agent badge)。关键:`pay_merchant` **先对验证节点 dry-run**(`would_reject`),
  拒绝就把验证节点的原始理由回灌,接受才真提交——拒绝一定来自链不是客户端。
- `agentpay_mcp/server.py` — MCP server,靠环境变量 attach 到已开预算(AGENTPAY_COMPONENT/AGENT_BADGE/
  AGENT_ACCOUNT/PER_TX_CAP/DAILY_CAP/WHITELIST/WALLETD_URL/BUDGET_TEMPLATE)。只暴露 3 个工具:
  `pay_merchant` / `get_budget_status` / `list_merchants`(故意没有提额/撤销自己的工具)。
- `demo_agent.py` — owner 侧直接用 SDK 开预算+revoke+withdraw;agent 侧走真 MCP。脚本化决策循环(**不需要 LLM key**),
  但工具层是真 MCP。中文叙述,风格同 `scripts/demo_zh.py`。

**演示验证(每条拒绝都是验证节点给的原文,经 MCP 回灌给 agent):**
付 700 ✓ → 付 1500 "Amount exceeds the per-transaction cap" → 付非白名单 "Merchant is not whitelisted"
→ 再付 700 ✓(累计 1400)→ 再付 700 "Amount exceeds the daily cap" → owner revoke → "Agent has been revoked"
→ owner 取回 8600,shop 实到 1400。

**依赖隔离:** 额外依赖只有 `mcp`(`requirements.txt`),装在 `integrations/agentpay_mcp/.venv`(Windows 用
`.venv/Scripts/python.exe`,Python 3.14 装 mcp 正常)。核心 SDK 保持纯标准库。

**跑法:** 仓库根目录(F:\\oolte):`integrations/agentpay_mcp/.venv/Scripts/python integrations/agentpay_mcp/demo_agent.py --auto`。

**踩坑:** owner 侧 `budget` 对象不知道 agent(server 那个独立 OnChainBudget 实例)花了多少 → `budget.spent` 恒为 0,
withdraw full fund 会被链 `InsufficientFunds` 拒(表现为 SDK run() 90s 超时后那笔 tx 结果是 `AcceptFeeRejectRest`)。
修法:用最后一次 `get_budget_status` 读到的链上 `spent_in_window` 来算 remaining。

**本地 swarm 复活:** 之前只有 esmeralda walletd(:5100)在跑,swarm(:12010)是停的。复活配方见 [[local-swarm-devnet]]:
`cd /root/ootle/swarm/run && rm -f tari_swarm.pid && ../bin/tari_swarm_daemon -c ./config.toml start -k --no-compile
--binaries-root /root/ootle/swarm/bin --wallet-daemon-auth none`(要在前台持续进程里跑,`nohup &` 会被 SIGHUP 杀)。
模板 `template_758d...` 发布后常驻,start -k 后仍在。相关:[[agent-budget-phase2]] [[agentpay-phase3]] [[tari-dev-needs-linux]]。

**升级为正式可安装 MCP server(2026-10-26,只动 `integrations/`):** 从 demo 升级成可一键装进 Claude Desktop/Cursor 的正式包。新增 `agentpay_mcp/config.py`(`ServerConfig` + `load()`:环境变量 + CLI flag 覆盖;网络预设 `local`/`esmeralda` 给默认 walletd/template/owner;默认本地,几乎零配置)。新增 `pyproject.toml`:`pip install -e integrations/agentpay_mcp` 装出 **`agentpay-mcp` 控制台脚本**(入口 `agentpay_mcp.server:main`,唯一依赖 `mcp`)。两种模式自动选择:**provision**(默认,无 `AGENTPAY_COMPONENT` 时 owner 账户现开一个新预算,近零配置,空白名单=付不了任何人)/ **attach**(给 component+badge+agent account,agent 只持 agent badge,production 形态)。`server.py` 改为**懒初始化 + 结构化错误**:建钱包失败不崩进程、只在成功时缓存(walletd 恢复后下次调用自动恢复);工具失败返回 `{ok:false,error_type,error,hint}`(`not_connected`/`not_configured`/`attach_failed`/`provision_failed`/`chain_error`),策略拒绝仍是 `{ok:false,reason,rejected_by}`。新增 `get_server_info` 工具(非机密配置+连通性)。CLI:`agentpay-mcp --print-config` / `--selftest`(连 walletd + 开/attach 预算后退出)。SDK 桥接增加 `AGENTPAY_SDK_PATH` 兜底(pipx/uvx 隔离安装用)。`list_merchants` 返回改 `{ok,merchants}`(demo 已同步)。本地 swarm 全部自测过:print-config(双网络)、selftest(provision 真开预算)、两条错误路径、`pip install -e .` 后 `agentpay-mcp` 脚本、完整 demo(4 工具可列、付款/三类拒绝理由回灌、revoke、对平)。README 重写:安装(pip/pipx/uvx)+ 配置表 + **可直接复制的 Claude Desktop/Cursor `mcpServers` 片段** + 结构化错误 + 前提。

**已在 esmeralda 公网跑通(2026-10-26):** 同一 MCP 集成指向 esmeralda(:5100)端到端成功——agent 通过真 MCP 工具付款,付 700✓ / 超单笔上限 / 非白名单 / 超每日上限 / 撤销后 全部被 **esmeralda 验证节点**拒绝并回灌理由,owner 取回对平。接线靠 3 个环境变量:`AGENTPAY_WALLETD_URL=http://127.0.0.1:5100/json_rpc`、`AGENTPAY_BUDGET_TEMPLATE=template_299d49bc…`(esmeralda agent_budget)、`AGENTPAY_OWNER_ACCOUNT=dev`(demo 默认找 "default",新加的 env 覆盖)。踩坑:①商户要上链才能收款,esmeralda faucet 空,改用 `accounts.transfer` 从 dev 发往商户 pubkey 把账户带上链;②公网 indexer 30s submit 超时对小交易也偶发,给 `sdk/src/agentpay/onchain.py` 的 `WalletdClient._submit_manifest` 加了**只针对网络瞬时错误**的重试(本地 swarm 不触发)。完整记录见 `docs/esmeralda.md` 的"真实 agent 集成@esmeralda"节。见 [[esmeralda-deploy-blocked]]。
