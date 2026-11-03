# 主网就绪计划 — Ootle L2 主网 2026-11-11（9 天）

> 目标：在 2026-11-11 Ootle L2 主网上线时，AgentPay 具备**以 owner 自营方式**上主网的条件。
> 本文是行动清单，不是宣传稿；每一条"已核实"都注明来源，没核实的明确写"待核"。
> 配套：`docs/compat-0.49.md`（兼容性会话产出）、`docs/wallet-integration.md`（钱包 spike 产出）、
> `web/DEPLOYMENT.md` §8、`docs/custody.md` §5、`docs/security.md`。

## 0. 已核实的事实（2026-11-02）

| 事实 | 来源 |
|---|---|
| 主网日期 **2026-11-11**，未公布具体时刻 | tari.com 首页倒计时；community.tari.com 公告 "The Ootle launches November 11, 2026!" |
| 上游 **v0.48.0 / v0.49.0 / v0.49.1 / v0.49.2 都是 11-02 当天发布**（pre-release）；v0.49.2 是 0.47 之后第一个带 Linux 二进制的版本。本仓库已于 11-02 迁到 **v0.49.2**（template_lib 0.37 / test_tooling 0.49.2），迁移详情见 `docs/compat-0.49.md` | github.com/tari-project/tari-ootle/releases；ootle.tari.com/guides/setup-a-wallet |
| 0.48/0.49 的破坏性变更直接命中我们：交易签名改为标准 sr25519（#3069）、显式主签名者（#3019）、proof 只在显式窗口内授权且只借出一跳（#3206）、公钥 badge 只授权所盖 frame（#3190）、新增 AuthorizeProof/DropProofAuthorization 指令（#3199）、创建已存在 substate 报 Conflict（#3128）、模板 metadata hash 编码改变（#3108/#3109/#3136）、ProtocolVersion 收缩为 V0 做 **testnet reset**（#3063）、indexer 改为 CBOR blob（#3101）、**模板升级改为 opt-in**（#3195）、PayRef 改名 DestinationTag（#3140）、发布计划费率表（#3078） | 同上 release notes |
| 主网 XTM 上 L2 的**唯一**文档路径：L1 **burn**（`minotari_console_wallet` Burn 标签或 gRPC `CreateBurnTransaction`；claim key 填 Ootle 账户的 64 位 hex 公钥，不是 `otl_…` 地址；Sidechain Key 留空）→ L2 **claim**（walletd `auto_claim_burns = true` 自动领，或 Web UI "Claim Burn" / JSON-RPC `accounts.claim_burn`）。**主网要 780 个 L1 确认，约一天**；esmeralda 100 个。1 Minotari = 1 TARI（扣 claim 手续费）。"A wrong key burns your funds for good." | ootle.tari.com/guides/burn-minotari、/guides/claim-burn |
| 发布费在 WASM 超过 **96 KiB** 后**二次方上涨**，上限 1 MiB，walletd 自动跑 wasm-opt。我们的 agent_budget **244.9 KiB**、escrow **156.1 KiB**（release profile 已是 `opt-level='s'` + lto + strip）。esmeralda 上发布费实测 ≈ 3.47 / 1.35 tTARI | ootle.tari.com/guides/publishing-templates；`docs/esmeralda.md` |
| 官方：walletd "不一定是你想用来管理主网资金的方式……面向最终用户的钱包在做" | ootle.tari.com/guides/setup-a-wallet |
| 测试网可 reset（会清空全部链上状态），主网 reset 命令拒绝执行 | 同上 |
| **未公布**：主网 indexer / walletd 公网端点、`tari publish -n` 主网网络名的确切拼写、testnet 状态是否迁移、Day-one checklist、主网费率的实际数值 | 以上所有页面均无 |
| 社区 11 月 build contest 主题 "MVP"，月末 UTC 截止；需开源许可 + 公开代码 + 社媒帖 | community.tari.com 规则帖 |

## 1. "具备上主网条件"的定义（范围决定，9 天内现实可达）

**做到：owner 自营部署。**
- AgentBudget + Escrow 在主网发布，并用小额真钱完成：开预算 → 代理付款确认 → 超限被验证节点拒绝 → `pay_via_escrow` + release。
- SDK / TS 客户端 / MCP / 仪表盘都有 `mainnet` 预设，默认地址指向主网模板。
- owner 用**自己的** walletd（独立主机或独立进程、只绑 loopback、keyring 口令、数据目录有验证过的备份），仪表盘开 auth + step-up + TLS，审计日志外送。
- 每个代理（API key / MCP 会话）用自己的链上 session badge（已实现），`AGENTPAY_REQUIRE_KEY_SESSIONS=true`。
- 资金策略：预算本金小额、按需 top-up；owner 账户里不放超过愿意暴露的金额。

**9 天内做不到、也不要宣称：**
- 面向公众的非托管多用户产品（Ootle 还没有面向用户的浏览器钱包；`wallet-spike` 会给出结论和改造计划）。
- 第三方安全审计。
- 滚动 24 小时上限：合约保持固定 epoch 窗口，产品文案按"每个窗口的额度"如实披露（`docs/audit-notes.md` #5）。
- OtcBoard：继续冻结，不发主网。

## 2. 阻塞项清单

### P0 — 不做就上不了
1. **0.49.x 兼容**（会话 `ootle-049-compat` 进行中）：模板升级到配套 template_lib / test_tooling，28/26/45 测试全绿；SDK、TS、`esme-fund` 按 sr25519 / 主签名者 / proof 授权窗口改好；在 0.49 本地 swarm 上三条 e2e + key→session 真链全过；产出 `docs/compat-0.49.md`。
2. **主网参数**：网络名、端点、费率、模板升级 opt-in 的机制与决策（发布时要不要声明可升级，不声明即永久不可变）→ 写进 MCP `config.py` 预设、web env 文档、SDK/TS README。
3. **资金准备（只有你能做）**：主网 L1（Minotari）钱包里要有足量 XTM。粗估：两个模板发布 ≈ esmeralda 的 4.8 tTARI × 主网费率倍数（待核，先按 ×3 备 ≈ 15 XTM）+ 运营手续费 + 预算本金；再加 20% 余量。burn 流程先在 esmeralda（reset 后）演练一遍，确认 claim key 填法。
4. **模板冻结**：决定主网版本改不改任何行为（建议：不改固定窗口；只允许文案/注释级改动）。冻结后在 0.47 和 0.49 两套 swarm 上都跑一遍 cargo test + e2e，记录最终 WASM hash。
5. **生产部署**：按 `web/DEPLOYMENT.md` §8 清单逐项打勾；walletd 数据目录备份与**恢复演练** ✅ 11-02 已在 0.47 esmeralda walletd 上通过（文件级恢复，docs/walletd-backup-drill.md；助记词导出是 owner 手动步骤），主网版本 walletd 上要重做一次。

### P1 — 上线一周内
- 主网 indexer 端点切换与 `indexer_trust` 设置的决定（esmeralda 用的是 trust，主网不要）。
- 告警（审计日志里的 denied / anomaly 要能通知到人）、备份自动化、费用统计。
- `AGENTPAY_REQUIRE_KEY_SESSIONS=true` 作为主网默认。
- 参加 11 月 MVP 比赛的话：公开帖 + 地址表。

### P2 — 之后
- 非托管前端（`wallet-spike` 结论后决定路线与技术栈）。
- 独立审计；`docs/custody.md` §5 的签名服务 / HSM / 多签。

## 3. 9 天时间表（11-02 → 11-11）

| 日 | 工程侧 | 你（owner）侧 |
|---|---|---|
| **D0 11-02** | 两个会话已开（0.49 兼容、钱包 spike）；本文 | ✅ 已持有 XTM；待办：放进自己的 minotari 主网 console wallet（不要留在交易所，burn 必须从自己控制的 L1 钱包发） |
| **D1–D2 11-03/04** | 0.49 兼容结论与修复；0.49 swarm 上模板全绿；主网参数表（网络名/端点/费率/升级 opt-in） | 把 XTM 转进主网 console wallet |
| **D3 11-05** | 模板冻结 + 升级 opt-in 决策；esmeralda reset 后重发 + burn→claim 演练；可选：试 `opt-level='z'` / 手动 wasm-opt 看体积能降多少 | 在 esmeralda 上亲手做一次 burn→claim |
| **D4 11-06** | mainnet 预设进 MCP / web / SDK 文档；生产部署脚手架（compose + Caddy + env）以 esmeralda 为后端演练 | 决定部署在哪台机器 / VPS |
| **D5 11-07** | 全链路演练：owner 开预算 → API key 发 badge → 代理付款 → 撤销 → 重新启用；**备份/恢复演练** | 复核 `web/DEPLOYMENT.md` §8 清单 |
| **D6–D7 11-08/09** | 缓冲：吸收上游 0.49.x 后续补丁；写 Day-0 操作手册（§4）；按 `docs/security.md` 审计清单自检 | 准备公告文案、地址表模板 |
| **D8 11-10** | 冻结一切改动；等官方公布主网版本/端点 | 主网 console wallet 就位，XTM 到账 |
| **D9 11-11 主网** | 装官方版本 walletd（`--network mainnet`）→ 建 owner 账户 → **L1 小额 burn 先试** → 等 780 确认 | 执行 burn（claim key = owner 账户公钥，Sidechain Key 留空） |
| **11-12** | claim 到账 → dry-run 估发布费 → 发布 escrow、agent_budget（带 `--max-fee` 余量与重试）→ 小额预算 + 小额付款 + 超限拒绝 + escrow 路径验证 → 切 MCP/仪表盘 mainnet 预设 → 公告地址 | 签发第一批 API key 会话 |

> 780 个确认 ≈ 一天：**不提前 burn，就不可能 11-11 当天发布**。L1 主网早已存在，理论上 burn 可以先做，但 L2 主网 genesis 之前的 burn 能否被 claim 要向官方确认；在社区问清楚之前，按 11-12 发布准备，别拿资金赌。

## 4. Day-0 操作手册（骨架，D6 填完整命令）

1. 安装官方主网版本的 `tari_ootle_walletd`、`tari` CLI、minotari 套件；校验 sha256。
2. 启动 walletd：`--network mainnet`、只绑 loopback、keyring 口令来自环境变量、`auto_claim_burns` 开；**立刻备份数据目录并验证能恢复**。
3. 创建 owner 账户，记录 64 位 hex 公钥（不是 `otl_…`）。
4. L1：`minotari_console_wallet` Burn → 金额先小（如 1 XTM）→ claim key = 上一步公钥 → Sidechain Key 留空 → 等 780 确认 → 确认 L2 到账后再 burn 主要金额。
5. 发布：`tari publish -n <主网名> -a <owner> -y --max-fee <dry-run 估值×1.2>`，先 escrow 后 agent_budget；记录 template 地址与 metadata hash。
6. 验证：SDK `scripts/e2e_onchain_pay.py` / `e2e_onchain_escrow.py` 指向主网 walletd 与新模板，金额用最小单位。
7. 切换：MCP `AGENTPAY_NETWORK=mainnet`、仪表盘 env、SDK/TS README 的地址表；`AGENTPAY_REQUIRE_KEY_SESSIONS=true`。
8. 公告：README 模板表加 mainnet 列；`docs/mainnet.md` 记录地址、tx、费用。

## 5. 风险

- **上游还在发版**（11-02 一天三个版本）：所有验证必须在"官方宣布的主网版本"上重跑一次，D6–D7 的缓冲就是留给这个的。
- **真钱 + 不可 reset**：主网模板发布即最终版本（除非 opt-in 升级）；发布费是真钱，245 KiB 的 agent_budget 在主网费率下可能明显高于测试网，先 dry-run。
- **公网 indexer 首日拥堵**：esmeralda 曾连续 40 次 submit 超时；发布与首批交易都带重试和费用余量，SDK 对真实提交不自动重发（H5），超时后先查钱包记录再重试。
- **私钥即资金**：walletd 数据目录丢失不可恢复；备份演练不通过不上主网。
- **claim key 填错资金永久丢失**：第一次 burn 只用小额。
- **范围蔓延**：9 天内任何"顺便重做前端"都会挤掉 P0；前端路线等 `wallet-spike` 结论，主网后再做。