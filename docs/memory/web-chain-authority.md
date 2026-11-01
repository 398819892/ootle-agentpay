---
name: web-chain-authority
description: 仪表盘改为链为权威 + tx 生命周期/幂等/启动对账/原子持久化(安全审查 Issue 4)
metadata:
  node_type: memory
  type: project
  originSessionId: 6aa70ce6-e982-4929-a1da-f18b0d94a749
  modified: 2026-10-27T00:34:37.451Z
---

安全审查 Issue 4 完成(commit `8a3c913`,master,未 push)。`web/` 仪表盘不再把本地 JSON 当财务权威:

- **链为权威读**:`readChainBudget()` 每次 `/api/state` 从链读 treasury(vault substate `revealed_amount`)、
  spend-in-window、caps、whitelist、revoked;`budget.source` 标来源。funded/withdrawn/ledger 来自 journal(链无 lifetime 总额)。
- **tx journal** `web/server/txlog.js`:`pending→confirmed|rejected|unknown`,pending 上链前落盘,超时记 unknown 绝不当成功。
- **幂等**:每幂等键一条记录(付款默认 invoiceId),重复不重复上链;记录按 component 归属。
- **启动对账** + `POST /api/reconcile`:用 txId `get_result` 结算 pending/unknown。
- **原子持久化** `writeJsonAtomic`(temp+fsync+rename,写失败抛错)。
- **clients/ts 最小扩展**(重建 dist):`lastTxId`、只读 `getResult`、`submit()`、可配 finalize 预算;`run()` 默认不变。

**关键环境坑**:重启后的本地 swarm 上 `pay`/`top_up`/owner 方法都被链拒(模板版本漂移,见 [[security-correctness-pass]]/
[[local-swarm-devnet]]),**只有 createBudget(open)会 ACCEPT**。要演示真 pay 需先修模板漂移(另一条线)。
自测 20/20 绿(链读一致/幂等只上链一次/重启对账/超时记 unknown/新建预算真 ACCEPT treasury==链上 vault)。
线上 8787 当时未重启(仍旧代码);重启用 `kill <pid>; wsl bash /mnt/f/oolte/web/run.sh`,首次加载会迁移旧 state→genesis 行。
dist 重建别在 /mnt 上 npm install(坏 node_modules),copy 到 WSL 原生目录 build。相关:[[web-custody-hardening-done]] 若有。
