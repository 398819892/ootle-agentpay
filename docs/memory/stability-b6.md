---
name: stability-b6
description: "B-6 稳定性验证 harness + 发现(mock walletd 驱动真后端,五类测试,多实例双花限制)"
metadata:
  node_type: memory
  type: project
  originSessionId: 8ec0c01a-97c7-49ae-8ed3-1eb26de3bcdd
  modified: 2026-10-27T05:15:52.797Z
---

B-6 稳定性/可靠性验证完成(本地 commit `7408c90`,master,未 push)。

**harness**:`scripts/stability/`——`mock_walletd.js`(链为权威的可控 mock,`POST /__control` 注入 down/延迟/
withheld verdict;**绝不碰真 swarm**)喂**未改动**的 `web/server/server.js`(env 覆盖端口/state/txlog)。
`make stability|soak|stability-fault|stability-crash|stability-idem|stability-multi`。crash 测试只 SIGKILL
自己起的测试后端(精确 PID),不 pkill、不动 walletd:12010。

**结论**:单实例健壮——1500 轮 soak 0 drift/无泄漏/链==journal;超时/unknown/down 绝不当成功;SIGKILL mid-flight
重启经启动 reconcile 恢复无双花无丢记录;同幂等键重试/超时/并发→链上只一次。

**修的 bug**(`runChainOp`):未提交失败的 op 不再继承 sticky `wd.lastTxId`,只有真推进才归属 txId。

**已知问题**(docs/stability.md):① **只能单实例**(JSON journal 整写+内存幂等 map;同键并发打两实例→**链上双花一张发票**,
共享 journal 被 clobber)=上线多节点前最高优先,需共享存储+分布式锁;链上 cap 仍是兜底(race 也冲不破 daily cap)。
② walletd 不通时付款被记**终态 rejected** 毒化幂等键(应区分传输失败=可重试)。③ 默认 money 限速 12/min。

关联 [[web-chain-authority]](A-2 tx 生命周期/reconcile)、[[integration-api-b5]](/api/v1)、[[security-correctness-pass]]。
