---
name: event-topic-namespacing
description: "Ootle 引擎把模板事件 topic 命名空间化为 \"<Struct>.<event>\"，按整串 == \"pay\" 过滤会丢掉所有 pay 事件"
metadata:
  node_type: memory
  type: project
  originSessionId: 30883ce1-2799-45ad-b5e4-1944cba09e7d
  modified: 2026-11-01T11:21:50.779Z
---

Ootle 引擎发出的模板事件，topic 会被加上结构体名前缀：模板里 `emit_event("pay", …)` 在链上实际是 **`"AgentBudget.pay"`**（escrow 是 `"AgentBudget.pay_via_escrow"`，手续费是 `"std.vault.pay_fee"`）。

**坑（2026-11-01 实查）：** 客户端 `payEvents`/`pay_events` 曾用 `topic == "pay"` 严格匹配（commit e297619 引入），结果当前模板的**每一笔 pay 事件都被丢弃**——付款在链上成功、treasury/spent 读链仍对，但仪表盘「动态」账本（渲染的是存下来的 event）显示「0 笔支付」。老测试用了不真实的裸 `"pay"` topic，所以没抓到。

**正确做法：** 按 topic 的**最后一段**匹配 `== "pay"`（`topic.rsplit(".",1)[-1]`），这样 `AgentBudget.pay` 和裸 `pay` 都收，`pay_via_escrow`/`pay_fee` 仍排除。两个客户端都要改：`clients/ts/src/budget.ts` 的 `payEvents`、`sdk/src/agentpay/onchain.py` 的 `pay_events`。

**已确认的付款补回：** 账本读的是 txlog 里存的 `event` 字段，修了解析也不会让**已经**记成 `event=None` 的旧记录显示。`server.js` 的 `reconcileAll` 加了 backfill：对 confirmed 但无 event 的 pay 记录重新 `getResult(txId)` 取回事件（POST /api/reconcile 返回 `backfilled` 计数）。

测试要用真实的 `"AgentBudget.pay"` topic，别用裸 `"pay"`。相关：[[local-swarm-devnet]]、[[web-chain-authority]]、[[payment-badge-proof-fix]]。
