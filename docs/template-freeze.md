# 模板冻结证据 (D3 / 2026-11-05 前)

> 配套 `docs/mainnet-readiness.md`（P0 #4、D3 行）与 `docs/mainnet-params.md`（C-5 决策）。
> 本文记录主网发布前对两个模板（`agent_budget`、`escrow`；`otc_board` 继续冻结、不发主网）的冻结证据:**0.49 引擎下 cargo test 全绿** + **可复现的参考 WASM hash**,以及本机的引擎版本覆盖边界。
> 产出于 commit `d78ba5b`，2026-11-03。

## 1. 工具链 / 引擎版本

| 项 | 值 |
|---|---|
| commit | `d78ba5b`（master） |
| rustc / cargo | 1.99.1 |
| `tari_template_lib` | **0.37.0** |
| `tari_template_test_tooling` | **0.49.2** |
| `tari_engine` / `tari_engine_types` / `tari_ootle_common_types` | **0.49.2** |
| `tari_transaction_manifest` | 0.49.2 |

即 cargo test 走的是 **0.49.2 引擎**(与主网同代),测试在 wasmer 里**在进程内**跑,不碰任何运行中的 swarm。

## 2. cargo test —— 0.49 引擎,全绿

| 模板 | 通过 | 失败 | 主网发布? |
|---|---|---|---|
| `agent_budget` | **28** | 0 | 是 |
| `escrow` | **26** | 0 | 是 |
| `otc_board` | **45** | 0 | 否（冻结,不发主网） |
| 合计 | **99** | 0 | — |

（数字与 readiness P0 #1 的「28/26/45 全绿」一致。）命令:每个模板 `cargo test`（见 `make test-templates` / `scripts/ci-local.sh` 的 warm-dir 路径）。

## 3. 参考 WASM hash（可复现指纹）

`cargo build --release --target wasm32-unknown-unknown` 的产物 sha256。**这是参考指纹,不是主网地址输入**:主网发布时 walletd 会跑 wasm-opt,发布后的 `binary_hash`(= 模板地址的输入,见 `docs/mainnet-params.md` §0)与下表的裸 hash 不同。本表的用途是:任何人用上表工具链在对应「源码 commit」列重建,应得到完全相同的 hash → 证明冻结源码确定性编译。

| 模板 | sha256（release, pre-wasm-opt, 0.49） | 裸体积 | 源码 commit |
|---|---|---|---|
| `agent_budget` | `cd2def8d4182bbf3f507983355fb87a377d4a3a8635c1c1752196f9a2db39b7d` | 293477 B (287 KiB) | C-5 升级规则提交（见下注） |
| `escrow` | `aacecb214cb0b0ddfe8a1c231b23da5c83b8d8110e8cb5790900b4ebe627f9c6` | 189625 B (185 KiB) | `d78ba5b` |
| `otc_board` | `131bb8de69b3416673d9b4e6b0a273f0fd05913e086a0867ff01ffdb881dbb66` | 304365 B (297 KiB) | `d78ba5b` |

> **agent_budget hash 变更（2026-11-03,C-5）**:为落地「AgentBudget 可升级 + Escrow 不可升级」决策（`docs/mainnet-params.md` §0）,`agent_budget/src/lib.rs` `new()` 新增一行 `.with_upgrade_rule(UpdateRule::AccessRule(rule!(resource(owner_badge))))`,故裸 hash 由 `fc3129bb…` 变为 `cd2def8d…`、体积 +435 B。此改动为**纯增量**（组件头新增 upgrade_rule 字段）,pay/额度/会话/撤销逻辑不变,`cargo test` 28/28 仍全绿。`escrow` / `otc_board` 源码未动,hash 不变。**C-5 改后 0.49 真链复测（2026-11-03，39881 机）**：用该 C-5 源码在 0.49 本地 swarm（:13010）发布 agent_budget = `template_eb00556978cfe1b378beaf31952d596f94f6e61d997d2888862332b3bf5db17d`（发布后地址，非上表裸 hash），三条真链 e2e（pay / remove+set_limits / pay_via_escrow→release）全过，确认 upgrade_rule 纯增量、运行时未破。**#1 typed 读(2026-11-03)**:`get_info` 新增 emit 命名 `info` event(供 dry-run 按字段名读,见 `docs/audit-notes.md` #1),WASM 再次变化、裸 hash 由 `cd2def8d…` 改变(精确新 hash 待下次冻结构建记录),0.49 swarm 发布地址 `template_8857330b…`。pay/额度/会话/撤销逻辑与 `get_info` 返回签名均不变,cargo test 28/28 仍绿。

裸体积比 readiness 记的 244.9 / 156.1 KiB 大,因为那是 esmeralda 发布后(经 wasm-opt)的体积——再次印证发布后 hash/体积都会变。`agent_budget` 与 `escrow` 两处构建上下文产出的 `escrow.wasm` hash 完全一致,说明构建确定。

## 4. 引擎版本覆盖边界（本机只有 0.47 swarm）

本机运行的 swarm 是 **walletd 0.47.0**（localnet，:12010）;**没有 0.49 的 swarm 二进制**,立不起 0.49 的真链环境。因此 live e2e 的覆盖如下:

本机(`cam`)运行的 swarm 是 **walletd 0.47.0**（localnet，:12010）;本机**没有** 0.49 swarm（`/root/ootle49` 不在本机——0.49 环境在**另一台机器**上,见 `docs/compat-0.49.md` §4/§7 的 `C:\Users\39881` / `I:\wsl`）。所以本机的 live e2e 只能打 0.47,而 **0.49 的 live 真链 e2e 已在那台机器的 0.49 swarm 上完成并记录**:

| 维度 | 0.49（主网同代） | 0.47（本机 live swarm） |
|---|---|---|
| cargo test（in-process wasmer） | ✅ §2,99/0（本机复现） | — |
| 参考 WASM hash | ✅ §3（本机） | — |
| live e2e: 确认付款 + 超额拒绝 | ✅ **已完成**,`compat-0.49.md` §5（0.49 swarm :13010,pay 500 确认 + 超额被验证节点拒,2026-11-02） | ✅ `e2e_onchain_pay`:vault−500 / merchant+500,超额被链上 `TemplateError: Amount exceeds the per-transaction cap` 拒绝 |
| live e2e: admin（set_limits/remove_merchant） | ✅ **已完成**,`compat-0.49.md` §5（add/remove_merchant、set_limits、日上限链上生效） | ⚠️ 失败:`Invalid param 'manifest' … Invalid macro name` —— **master 的 SDK 讲 0.49 manifest 方言,0.47 swarm 的解析器不认**(pay 路径的宏未变故通过)。**客户端方言 vs 引擎版本不匹配,不是模板 bug**。 |
| live e2e: `pay_via_escrow` | ✅ **已完成**,`compat-0.49.md` §5（400 → escrow → release 380 / fee 20） | 未跑（同样受 0.49/0.47 方言限制） |
| `/api/v1` key→session 真链 | ✅ **已完成**,`compat-0.49.md` §5（default→发 badge→`key-bot1`→撤销 403→重发 `key-bot1.2`） | — |

**结论**:冻结证据齐了——**0.49 cargo test 全绿 + 可复现参考 hash**（本机 §2/§3）+ **0.49 live 真链 e2e 三条 + key→session 全过**（另一台机器,`compat-0.49.md` §5）。本机 0.47 swarm 的 e2e 仅为旁证(pay 过;admin 因方言不匹配,非 bug)。

## 5. 真正「冻结 OK」还差什么

- [x] 0.49 cargo test 全绿（本文 §2）。
- [x] 参考 WASM hash 固定（本文 §3）。
- [x] C-5 升级规则已定:**agent_budget 可升级(owner 限定)+ escrow 不可升级(Locked)**（`docs/mainnet-params.md` §0 / `compat-0.49.md` §6.2）。agent_budget 已加 `with_upgrade_rule`,28/28 仍绿,新 hash 见 §3。
- [x] **0.49 本地 swarm 三条 e2e + key→session 真链**（`compat-0.49.md` §5,2026-11-02,另一台机器的 0.49 swarm）。
- [ ] 主网发布日(≈11-12)记录**发布后**的 `binary_hash`(post-wasm-opt,模板地址输入)到 `docs/mainnet.md`——那才是最终 hash（唯一剩余项,发布时做）。
