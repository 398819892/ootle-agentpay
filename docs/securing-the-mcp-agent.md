# 给 MCP agent 上锁:从托管改到非托管

> 面向运维的落地清单。概念与权衡见 [`deployment-noncustodial.md`](deployment-noncustodial.md);
> 这里只讲"你现在是什么样、要改成什么样、一步步怎么做"。

AgentBudget 的四条限制(单笔上限、窗口上限、商户白名单、急停)是**验证者在链上**对
**agent 徽章持有者**强制的。但它们只有在 **agent 只持有自己的 agent 徽章、用自己的、最小权限的
walletd 凭证** 时,才是真正的安全边界。否则它们只是 API 层的便利。

---

## 1. 现状(本地 dev,完全托管)

Claude Desktop 现在传给 MCP 的全部配置:

```jsonc
// %APPDATA%\Claude\claude_desktop_config.json
"agentpay": {
  "command": "F:\\oolte\\integrations\\agentpay_mcp\\.venv\\Scripts\\agentpay-mcp.exe",
  "env": {
    "AGENTPAY_NETWORK": "local",
    "AGENTPAY_COMPONENT": "component_e1e5…5366b"
  }
}
```

把缺省值展开后,实际效果是:

| 项 | 实际值 | 后果 |
|---|---|---|
| `AGENTPAY_AGENT_ACCOUNT` | 未设 → 默认 = owner 账户 `default` | **同一个账户同时持有 owner 徽章 + agent 徽章** |
| `AGENTPAY_WALLETD_TOKEN` | 未设 → 客户端自己铸 | — |
| `AGENTPAY_WALLETD_PERMISSIONS` | 未设 → 默认 `Admin` | 铸出的是 **Admin token** |
| walletd (`127.0.0.1:12010`) | 本地 swarm,`auth=none` | 直接发放 Admin |

**结论:谁能驱动这个 MCP(或直接连到 `127.0.0.1:12010`),就能为 `default` 账户签任何交易**——
提走整个金库、改上限、加白名单、revoke 都行,链上的 per_tx / daily / 白名单上限**形同虚设**。

### 为什么 dev 里暂时可以接受
- `network=local`:本地 dev swarm,花的是测试币(tTARI),不是真钱。
- walletd 只在 `127.0.0.1`,只有本机进程够得着。

**不要**把这个配置形状照搬到生产或任何联网/多人环境——那等于金库裸奔。危险点是那个
`auth=none` 的本地 walletd:别暴露 `12010` 端口,也别在公用机器上这么跑。

---

## 2. 目标:非托管(上限才真正生效)

owner 和 agent 是**不同账户、不同 walletd**:

- **Owner 侧**(你,离线/运维):持 owner 徽章 + 出资账户。只有它能 `open` / 设上限 / 管白名单 /
  `withdraw` / `revoke`。**绝不进 agent 环境。**
- **Agent 侧**(AI 的运行环境):自己的 walletd、自己的账户,**只持 agent 徽章**,用**最小权限**
  token。只能在上限内 `pay`,别的都不行。被完全攻陷,最坏也就是"上限内付白名单",直到 owner revoke。

### Agent 侧 env 模板

```jsonc
"agentpay": {
  "command": "…\\agentpay-mcp.exe",
  "env": {
    "AGENTPAY_NETWORK": "esmeralda",                       // 或你的目标网络;本地测试仍可用 local
    "AGENTPAY_COMPONENT": "component_…",                    // owner 开好的预算组件
    "AGENTPAY_WALLETD_URL": "http://agent-walletd:12010/json_rpc",  // agent 自己的 walletd,不是 owner 的

    "AGENTPAY_AGENT_ACCOUNT": "agent",                      // ≠ owner 账户;只放 agent 徽章
    // 可选:显式指定 agent 徽章资源;不设则从组件状态自动推导
    // "AGENTPAY_AGENT_BADGE": "resource_…",

    // 二选一的最小权限 walletd 鉴权:
    // A) 预铸好的有限期 token(推荐)
    "AGENTPAY_WALLETD_TOKEN": "<least-privilege bearer token>",
    // B) 让客户端自己铸,但只要提交/读取交易的窄权限(名字以你的 walletd 为准,绝不要 Admin)
    // "AGENTPAY_WALLETD_PERMISSIONS": "TransactionSend,TransactionGet",
    // "AGENTPAY_WALLETD_CREDENTIALS": "<credential>"
  }
}
```

> agent 的 env 里**不放** owner 账户、owner 徽章、出资账户、任何 Admin 凭证。
> token 要有有限期并**定期轮换**。

---

## 3. 落地清单

- [ ] Owner 开好预算,`issue_agent_badge(session, to_account="agent")` 把 agent 徽章发到**独立的**
      agent 账户。
- [ ] Agent 跑在**自己的** walletd(`AGENTPAY_WALLETD_URL`),不是 owner 的。
- [ ] Agent 的 token 是**最小权限**(只提交/读取交易)、有限期、可轮换——**绝不 Admin**。
- [ ] `AGENTPAY_AGENT_ACCOUNT` ≠ owner 账户;该账户**只**持 agent 徽章。
- [ ] agent 环境里**没有** owner 徽章、出资账户、Admin 凭证。
- [ ] walletd **关掉 `auth=none`**,不对外暴露端口;限制谁能连它、谁能驱动这个 agent
      (注意提示注入:能操纵 AI 的人就能在上限内触发付款)。
- [ ] `per_tx_cap` / `daily_cap` 设保守(daily 是固定纪元窗口,跨窗口最坏约 2 倍,见
      `docs/audit-notes.md` #5),白名单保持最小。
- [ ] owner 侧随时能 `revoke`(全局)/ `revoke_session`(单徽章)当急停。

---

## 4. 验证改对了没有

1. `get_server_info`:`mode` 仍是 `attach`,但现在 `AGENTPAY_AGENT_ACCOUNT` 应 ≠ owner。
2. 确认 agent 账户**不**持 owner 徽章(持了就还能 withdraw/revoke)。
3. 确认 agent 的 token **不是** Admin(用 walletd 侧的 token/权限查询核对)。
4. 演练一次 owner `revoke_session`,确认该 agent 立刻付不了款。

> 这条路线**不**改变:agent 仍然只被你设的上限约束——把上限设合理。托管的面板(dashboard)
> 按设计仍是托管的;本文是给"自己持钥匙"的 agent 用的。

## 5. 每笔付款的人工确认

链上上限是硬边界;在它之内,**每一笔**付款还应该经你本人点头。确认发生在你的 AI 应用自己的
工具授权弹窗里,而不是聊天里:

- **Claude Desktop(及类似客户端):** 让 `pay_merchant` 保持「每次询问 / Ask every time」,
  **不要**设成「始终允许 / Always allow」。每次付款时客户端会弹出「允许运行 pay_merchant?」并显示
  商户与金额——点一下允许就是你对这笔的确认,口令不进聊天。设成"始终允许"会**取消**这道确认,
  等于让 agent 在上限内自由付款。
- **控制台「支付确认」** 里的"额外口令"是可选加强层,需要客户端支持安全弹框(MCP elicitation)。
  Claude Desktop 暂不支持,保持关闭即可,靠上面的授权弹窗确认。支持的客户端可开启,口令只在
  控制台校验(存 SHA-256,绝不离开本机)。
