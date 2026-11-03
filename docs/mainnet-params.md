# 主网参数表（权威单一来源）

> 配套 `docs/mainnet-readiness.md`（9 天计划）。本文是**主网上线要定死的参数**的唯一权威表：工程侧按此填代码/文档，owner 侧按此执行 Day-0 runbook。
> 状态口径：**已定**=本仓库已拍板（可直接写死）；**已知**=官方/实测已有数值；**待官方**=Ootle 官方尚未公布，上线版本到手再核；**待发布后**=主网发布（≈11-12）产生后回填。
> 最后更新：2026-11-03。

## 0. C-5 模板升级规则 —— 已定:**AgentBudget 可升级(owner 限定)+ Escrow 不可升级**

| 项 | 结论 |
|---|---|
| 决策 | `agent_budget` 组件实例以 `upgrade_rule = AccessRule(owner badge)` 发布 —— 仅 owner-badge 持有者可经 `UpdateComponentTemplate` 把自己的预算迁到修正后的新 agent_budget 模板（agent badge 不能升）。`escrow`（及不上主网的 `otc_board`）保持默认 `Locked` = 不可升级。 |
| 为什么 | AgentBudget 逻辑复杂（额度/窗口/白名单/会话/撤销）,主网若发现模板 bug,owner **原地迁移**比「`withdraw`→发新模板→重开→refund→重发 badge」成本低得多,且客户端地址表不变（组件地址不变）；升级权锁死在 owner 徽章、迁移帧引擎受限（#3206 不能碰 vault/外呼）。Escrow 的**不可变本身是其资金托管担保**（托管期「连 owner 也改不了规则」）,故保持 `Locked`；且 Escrow 无 owner 徽章,`Owner` 规则会落到创建者密钥（`pay_via_escrow` 下即 AgentBudget 组件,语义不对）。权衡:owner-key 失陷的爆炸半径从「提走当前余额」扩大到「可把预算迁到新模板」,但新模板仍须 owner 自己发布、内容寻址可审计,非任意改写。 |
| 机制（已核实源码，详 `docs/compat-0.49.md` §6.2 / #3195） | **模板**（`template_xxx` 地址）按 `hash(author, binary_hash)` 内容寻址，永远不可变。0.49 的「升级」指把一个**组件实例**用 `UpdateComponentTemplate` 指向新模板，校验该组件头里的 `upgrade_rule`（**创建时固定、永不可改**）:`Locked`（**默认**）= 谁都不能升；`Owner` / `AccessRule(r)` = 对应规则可升。设置方式是组件构造里 `Component::new(..).with_upgrade_rule(UpdateRule::...)`。**`agent_budget` 的 `new()` 现调 `.with_upgrade_rule(UpdateRule::AccessRule(rule!(resource(owner_badge))))`；`escrow` / `otc_board` 不调 → 默认 `Locked`。** |
| 对 D3 冻结的影响 | **需要改 `agent_budget` 合约代码**（已改:`new()` 新增一行 builder 调用）。28/28 cargo test 仍绿（行为不变）,新 WASM hash `cd2def8d…`（见 `docs/template-freeze.md` §3）。`escrow` / `otc_board` 不变,hash 不变。 |
| 核实状态 | 机制已由 0.49 源码核实（§6.2）。**限制:**enforcement 测试（owner 能升 / agent 不能升）暂**无法写**——test_tooling 0.49.2 未暴露驱动 `UpdateComponentTemplate` 的 API；依赖现有 28 测试做回归,主网/0.49 CLI 待核一次实际迁移。 |
| bug 补救 runbook | **agent_budget:** owner 发布修正后的新 agent_budget 模板（新地址）→ 用 owner badge 对每个预算组件执行 `UpdateComponentTemplate` 迁到新模板（额度/会话状态保留,无需 withdraw/重开/重发 badge,无需切客户端地址表）。**escrow（不可升级）:** owner `withdraw` 旧托管余额 → 发布新 escrow 模板（新地址）→ 新模板重开 → 切客户端地址表；旧组件跑旧代码直到被提空。 |

## 1. 参数表

| 参数 | 值 | 状态 | 写入位置 / 备注 |
|---|---|---|---|
| 主网日期 | 2026-11-11 | 已知 | 官方倒计时;具体时刻未公布 |
| `tari publish -n` 网络名 | `mainnet`（拼写待确认） | 待官方 | 发布命令;readiness D1–D2 |
| 模板升级规则（组件 `upgrade_rule`） | **agent_budget = `AccessRule(owner badge)`（owner 可升）；escrow = `Locked`（不可升）** | 已定 | 见 §0;在模板 `new()` 里设,非发布旗标 |
| agent_budget 模板地址 | `template_…` | 待发布后 | config.py PRESETS / web env / SDK+TS README / docs/mainnet.md |
| escrow 模板地址 | `template_…` | 待发布后 | 同上 |
| owner walletd JSON-RPC | owner 自有、仅绑 loopback（端口待定，官方主网 walletd `--network mainnet`） | 待官方 | `AGENTPAY_WALLETD_URL`;不对公网暴露 |
| indexer 端点 + `indexer_trust` | 主网端点待公布;**主网不用 trust**（esmeralda 才用） | 待官方 / 已定(不用 trust) | walletd 配置;readiness P1 |
| owner 账户名 | owner 在主网新建（如 `owner`） | 待发布后 | `AGENTPAY_OWNER_ACCOUNT`;记录 64 位 hex 公钥 |
| 发布费 | dry-run 现估;esmeralda 实测 ≈ 3.47 / 1.35 tTARI(agent_budget/escrow);主网费率倍数待核(先按 ×3 备 ≈15 XTM) | 已知(参照) / 待官方(主网费率) | `tari publish --max-fee <估值×1.2>` |
| WASM 体积 / 最终 hash | agent_budget 244.9 KiB、escrow 156.1 KiB;冻结时在 0.47+0.49 两套 swarm 跑 cargo test 后记录最终 hash | 已知 / 待发布后(hash) | docs/mainnet.md |
| `AGENTPAY_REQUIRE_KEY_SESSIONS` | `true` | 已定 | 已是代码默认(S-7);主网显式再设一次 |
| 资源 / 代币 | 预算锁定「被注资的明文可数资源」,不绑单一代币;confidential 不可枚举(spike 方案 a) | 已定 | 余额展示单位主网为 TARI/XTM |
| memo | 明文公开出链(≤253B);**不放任何机密** | 已定 | D-9;产品文案照实披露 |
| 额度窗口 | 固定 epoch 窗口(非滑动),跨界最多约 2× cap;如需 24h 绝对上限,把 daily_cap 设为真实上限的一半 | 已定 | docs/audit-notes.md #5 |

## 2. 发布后要回填主网地址的位置（11-12 清单）

1. `integrations/agentpay_mcp/agentpay_mcp/config.py` — 在 `PRESETS` 加 `"mainnet"` 条目（walletd_url / budget_template / owner_account）。在此之前 **D-8 已支持用显式 env 跑主网**（见 §3），不需要占位假地址。
2. `web/` 部署 env（`web/DEPLOYMENT.md` §8 / compose env）。
3. `clients/ts` README 与 `sdk` README 的地址表加 mainnet 列。
4. `docs/mainnet.md`（新建）记录:模板地址、发布 tx、费用、最终 WASM hash、owner 账户公钥。
5. README 根模板表加 mainnet 列。

## 3. 在加 PRESETS 之前,如何跑主网（D-8 fail-closed 下的显式路径）

主网地址未进 `PRESETS` 之前,直接给足显式 env 即可——`config.py` 的 D-8 对未知网络名 fail-closed,但显式给了 walletd_url 就放行,并保留真实网络名 `mainnet`:

```bash
AGENTPAY_NETWORK=mainnet \
AGENTPAY_WALLETD_URL=http://127.0.0.1:<port>/json_rpc \
AGENTPAY_BUDGET_TEMPLATE=template_<agent_budget 地址> \
AGENTPAY_OWNER_ACCOUNT=<owner 账户名> \
AGENTPAY_REQUIRE_KEY_SESSIONS=true \
agentpay-mcp
```

（不给 `AGENTPAY_WALLETD_URL` 而只设 `AGENTPAY_NETWORK=mainnet` 会被 D-8 直接拒启,避免误把主网跑到本地 swarm 配置上。）
