# 主网参数表（权威单一来源）

> 配套 `docs/mainnet-readiness.md`（9 天计划）。本文是**主网上线要定死的参数**的唯一权威表：工程侧按此填代码/文档，owner 侧按此执行 Day-0 runbook。
> 状态口径：**已定**=本仓库已拍板（可直接写死）；**已知**=官方/实测已有数值；**待官方**=Ootle 官方尚未公布，上线版本到手再核；**待发布后**=主网发布（≈11-12）产生后回填。
> 最后更新：2026-11-03。

## 0. C-5 模板升级规则 —— 已定:**不可升级(immutable)**

| 项 | 结论 |
|---|---|
| 决策 | `agent_budget` 与 `escrow` 两个模板在主网**以不可升级方式发布**（发布时**不** opt-in 升级）。 |
| 为什么 | 链上硬额度「连 owner 也不能事后改」是产品核心卖点（与 C-1 revoke 不可逆同理）；immutable 让 owner-key 失陷的爆炸半径仍只是「提走当前余额」（owner badge 本就能），而非「改写未来所有行为」。v1 为 owner 自营、本金小额、随时可 `withdraw` 重开，模板若有 bug 的补救成本低。 |
| 机制（已核实） | Ootle 模板按 `hash(author_pubkey, binary_hash)` **内容寻址**（`tari_engine_types/published_template.rs`）——换代码即换地址，每个模板地址天生不可变。「模板升级 opt-in」(#3195) 是**引擎/发布层**特性，由主网 `tari publish` 的旗标声明;**不声明 = 永久不可变 = 我们要的默认**。`template_lib` 的 `UpdateRule` 只管资源(mintable/burnable)可变性，与 WASM 代码升级无关。 |
| 对 D3 冻结的影响 | **不需要改任何合约代码**。C-5 是发布时的策略决定，不是代码改动——冻结的是现有 WASM，本条只要求「发布时别加升级旗标」。 |
| 待官方 | 主网 `tari publish` 中「不可升级 = 默认」这一点的确切旗标/行为，待主网 CLI 到手后在 D6–D7 核一次（预期:不传升级旗标即 immutable）。 |
| bug 补救 runbook | 不原地热修。发现模板 bug 时:owner 用 owner badge `withdraw` 旧预算余额 → 发布修正后的新模板（新地址）→ 在新模板上重开预算并 top-up → 切客户端地址表。旧预算继续跑旧代码直到被提空。 |

## 1. 参数表

| 参数 | 值 | 状态 | 写入位置 / 备注 |
|---|---|---|---|
| 主网日期 | 2026-11-11 | 已知 | 官方倒计时;具体时刻未公布 |
| `tari publish -n` 网络名 | `mainnet`（拼写待确认） | 待官方 | 发布命令;readiness D1–D2 |
| 模板升级 opt-in | **否（immutable）** | 已定 | 见 §0;发布命令**不**加升级旗标 |
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
