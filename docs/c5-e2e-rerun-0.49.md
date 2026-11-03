# C-5 改后 agent_budget — 0.49 live e2e 重跑 runbook

> 配套 commit `6480540`(C-5:agent_budget `new()` 加 `with_upgrade_rule(AccessRule(owner_badge))`)。
> 模板内容变了(新 WASM hash `cd2def8d…`),需在**另一台 0.49 swarm 机(39881,`I:\wsl`,`/root/ootle49`)**上重发 agent_budget 并重跑三条真链 e2e,确认运行时行为未破。本机(cam)只有 0.47 swarm,跑不了。
> 用法:把下面代码块整段粘给 39881 那台机上的 Claude Code 会话。`<仓库克隆目录>` 若它找不到需人工补。

```
在本机的 0.49 本地 swarm 上,对改动过的 agent_budget 模板重跑 live e2e。背景:仓库
398819892/ootle-agentpay 的 master 刚加了 C-5 改动(commit 6480540)——agent_budget 的
new() 新增 .with_upgrade_rule(UpdateRule::AccessRule(rule!(resource(owner_badge)))),让
owner 徽章可迁移预算到新模板;escrow/otc_board 不变。这是纯增量改动,需在 0.49 真链确认
pay/额度/会话/撤销运行时行为未被破坏(升级迁移本身不测——test_tooling 0.49.2 没有驱动
UpdateComponentTemplate 的 API)。

请按顺序做,每步贴出关键输出:
1. 确认 0.49 swarm 在跑:bash /mnt/i/wsl/setup/c49-swarm.sh status
   (没起就 c49-swarm.sh start;注意首次启动不要带 -k,否则 epoch 卡 0、No committee VNs found)
   swarm 的 walletd 在 http://127.0.0.1:13010/json_rpc。
2. 进本机的 ootle-agentpay 克隆目录,git pull 确认 HEAD 含 commit 6480540。
3. 只重发 agent_budget(escrow 不重发,源码没动):
   bash /mnt/i/wsl/setup/c49-publish.sh agent_budget   # CLI 0.34.1, -n localnet -a default
   记下打印出来的新 template_ 地址。
4. 跑三条 e2e(默认 0.49 方言,不要设 AGENTPAY_PROOF_WINDOWS):
   WALLETD_URL=http://127.0.0.1:13010/json_rpc \
   AGENT_TEMPLATE=template_<第3步的新地址> \
   ESCROW_TEMPLATE=template_f4c323fcd0c05aef17f9d4070e2e97dbecd969eca7633aebdae5af52025eac82 \
   python scripts/e2e_onchain_pay.py && \
   python scripts/e2e_onchain_admin.py && \
   python scripts/e2e_onchain_escrow.py

期望 3/3 通过:pay 500 确认 + 超限被验证节点拒(Amount exceeds the per-transaction cap);
admin 的 set_limits / add_merchant / 日上限链上生效;pay_via_escrow 400 → escrow 组件 →
release 380 / fee 20。

跑完请报告:三条脚本各自 pass/fail、以及第3步新的 agent_budget template 地址。若有失败,贴
完整错误和对应脚本名。
```

## 回填清单(拿到结果后)
- 新 agent_budget 模板地址 → `docs/compat-0.49.md` §5(替旧 `template_1dc1be00…`)、`docs/template-freeze.md`。
- 三条 e2e 3/3 结果 → `compat-0.49.md` §5 证据行(标注「C-5 改后复测」)。
- escrow 地址不变:`template_f4c323fcd0c05aef17f9d4070e2e97dbecd969eca7633aebdae5af52025eac82`。

## 执行结果（2026-11-03，已在 39881 机完成）
- 同步 C-5 源码到 ext4 → `c49-publish.sh agent_budget` 发布到 0.49 swarm（:13010）。
- **新 agent_budget 模板**：`template_eb00556978cfe1b378beaf31952d596f94f6e61d997d2888862332b3bf5db17d`（旧 `1dc1be00…` 为 C-5 前）。escrow 不变 `template_f4c323fc…`。
- 三条 e2e 用新地址（默认 0.49 方言）**3/3 全过**：pay 500 确认+超限被验证节点拒；remove/add_merchant、set_limits、日上限链上生效；pay_via_escrow 400→escrow→release 380/fee 20。
- 结论：C-5 的 `with_upgrade_rule` 为纯增量改动，pay/额度/会话/撤销/escrow 运行时行为未被破坏。已回填 `compat-0.49.md` §5、`template-freeze.md` §3、`mainnet-readiness.md`。
- 回填清单：[x] 新地址 [x] 3/3 结果 [x] escrow 不变。
