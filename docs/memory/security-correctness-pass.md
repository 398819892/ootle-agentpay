---
name: security-correctness-pass
description: 安全/正确性修复 pass——金额 BigInt 化、reset/resolveMerchant 收紧、OTC 信任文档、OtcBoard 质押漏洞修复 + swarm 模板漂移坑
metadata:
  node_type: memory
  type: project
  originSessionId: 8243757f-006b-4250-b8df-68f156b5524e
  modified: 2026-10-26T12:17:55.127Z
---

2026-10-26 一轮静态审查近端项修复(不加功能)。工作区改了,未 commit/push。详见 side-session-notes 里
`security-correctness-pass.md`(完整五项 + 验证)。要点:

- **金额全链路 BigInt/字符串化**:web/server.js `toAmount` 返回整数串 + BigInt 运算;clients/ts `budget.ts`
  加 `amt()`/`big()`,caps/spent 字段改字符串;app.js `readAmt`/`amtBig`/`fmt` 大整数精确。防 2^53 丢精度 +
  科学计数污染 manifest。
- **#5 是真漏洞已修**:`templates/otc_board` 的 `unstake_arbiter` 原本无守卫,仲裁人可在 `Disputed` 时取回
  质押逃避罚没。加 `has_open_dispute_for` 守卫 + 2 测试。**cargo test 18/18 全绿**(原16+新2)。
- reset 加明确 notice(只清本地视图);resolveMerchant 加 `AUTO_CREATE_MERCHANTS` 开关(默认 `!AUTH_ON`),
  生产默认不自动建号注资。
- 测试数对齐:**Escrow 17 / AgentBudget 14 / OtcBoard 18 = 49**;标注 `ootle_chain.OotlePyChain` 实验性未验证。

**环境坑(重要)**:swarm 重启后模板地址漂移——默认 localnet AgentBudget `758d0c58…` 已旧,当前真实地址是
`template_31cfc3fb…`;且 budget.ts 的 badge sort 启发式与新模板 mint 顺序不一致 → 活链 pay 报
"Proof of resource did not match"。两者都与本次改动无关(git diff 证明 manifest 参数/badge 逻辑没动),是
模板版本漂移,属另一条待办线。另:`wsl bash -lc '... &'`/`setsid` 起的后台进程 launcher 返回即被杀,常驻
服务要用 harness run_in_background + `exec`。相关:[[local-swarm-devnet]] [[otc-board-phase4]] [[web-dashboard-phase7]] [[ts-client-phase6]]
