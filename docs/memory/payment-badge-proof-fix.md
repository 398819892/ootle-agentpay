---
name: payment-badge-proof-fix
description: "确认付款曾被链拒的真 bug——badge 要从组件链上状态读,不能按地址排序猜;已加真实链上 e2e"
metadata:
  node_type: memory
  type: project
  originSessionId: 07a91e4c-40a5-42fb-a4d5-7be95e752303
  modified: 2026-10-27T09:43:09.888Z
---

AgentPay 确认付款在多会话 badge 模板上曾被链拒(commit 8f7ead7, master, 未 push)。

根因:SDK(`sdk/src/agentpay/onchain.py`)和 TS 客户端(`clients/ts/src/budget.ts`)的 `open()`
用 `sorted()` 对两个 badge 资源地址排序,假定 `[owner, agent]`。排序序 ≠ 铸造序,于是 `agent_badge`
可能指到 owner badge 资源;`pay` 证明 `agent_badge`,模板 `assert_resource(self.agent_badge)` 不符 →
链上 Reject「Proof of resource did not match」。单测 mock 了链、cargo 只测模板,从没跑过真 confirmed 付款。

**修法(只改客户端,模板没动、没重发):** 从组件链上状态读 owner/agent 映射——state 是结构体顺序
`[vault(CBOR tag132), owner_badge(tag131), agent_badge(tag131), per_tx, daily, …]`,取两个 tag-131
资源即 `[owner, agent]`。绝不按地址排序猜。`web/server/state.json` 的 badge 曾写反,已按链校正(该文件未被 git 跟踪,是运行态)。

教训:**mock 单测会掩盖真实链上拒绝**。已加 `scripts/e2e_onchain_pay.py`(`make e2e` / `RUN_E2E=1`)
真跑开预算→确认付款→核对金库-、商家+;接进 `scripts/ci-local.sh` 作为门控集成套件(无 swarm 时 SKIP,
付款挂时 FAIL),GitHub CI 不设 RUN_E2E 故跳过而非假绿。关联 [[agent-budget-phase2]] [[agentpay-phase3]] [[integration-api-b5]]。

注意:8787 上那个常驻 web server(早于本次修复启动)内存里还是旧(写反的)badge,需重启才会重读校正后的 state.json。
