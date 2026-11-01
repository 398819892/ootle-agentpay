---
name: manifest-injection-fix
description: "#7 manifest 注入修复——校验在 manifest builder 底层，memo 用\"拒绝危险字符\"非转义"
metadata:
  node_type: memory
  type: project
  originSessionId: 8ce1773d-841f-48fe-9b20-7844f2985776
  modified: 2026-10-30T09:05:39.056Z
---

评审 #7：交易 manifest 是字符串拼接，`memo`/地址/session/amount 未校验=注入（commit `7c917a3`，本地未 push）。

**修复原则（将来改付款路径必须守）**：校验放在**最底层的 manifest 构造函数内部**（`onchain.py` 的 `_check_*` + 每个 builder；`budget.ts` 的 `check*`；`server.js resolveMerchant`），不靠 `_precheck`/调用方——这样直接用 SDK 的 `pay/pay_invoice/issue_agent_badge/open` 也被保护。

**非显然决定**：
- memo 选"**拒绝** `"`、反斜杠、控制字符、>253 字节"而非转义——不依赖 manifest 解析器的 `\"` 转义语义是否正确；拒绝后 memo 可证明留在字面量内。普通标点/unicode 放行。
- 地址严格 `^<kind>_[0-9a-f]{64}$`（component/resource/template）；session `^[A-Za-z0-9_.-]{1,64}$`；amount 只允许非负十进制整数。

**#9 已改**：invoice.ts/invoice.py 顶注释原称 memo 是"加密 stealth 输出"=错，memo 是链上公开明文（写进 pay 事件），见 docs/security.md。

**坑**：本地 swarm 默认模板 758d0c58 是旧版 agent_budget（`pay` 只 3 参、无 memo），跑 `clients/ts/dist/demo.js` 的 pay 会报 `pay expected 4 arguments, but got 5`——是链上模板漂移，不是客户端 bug；open 仍成功上链。要真跑通付款需重发当前模板。见 [[local-swarm-devnet]] [[ts-client-phase6]] [[security-correctness-pass]]。
