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

`cargo build --release --target wasm32-unknown-unknown` 的产物 sha256。**这是参考指纹,不是主网地址输入**:主网发布时 walletd 会跑 wasm-opt,发布后的 `binary_hash`(= 模板地址的输入,见 `docs/mainnet-params.md` §0)与下表的裸 hash 不同。本表的用途是:任何人用上表工具链在 `d78ba5b` 重建,应得到完全相同的 hash → 证明冻结源码确定性编译。

| 模板 | sha256（release, pre-wasm-opt, 0.49 @ d78ba5b） | 裸体积 |
|---|---|---|
| `agent_budget` | `fc3129bbcab29f71853c4c23bed4e0e947e9181ed474a9dac539fd45c0662794` | 293042 B (286 KiB) |
| `escrow` | `aacecb214cb0b0ddfe8a1c231b23da5c83b8d8110e8cb5790900b4ebe627f9c6` | 189625 B (185 KiB) |
| `otc_board` | `131bb8de69b3416673d9b4e6b0a273f0fd05913e086a0867ff01ffdb881dbb66` | 304365 B (297 KiB) |

裸体积比 readiness 记的 244.9 / 156.1 KiB 大,因为那是 esmeralda 发布后(经 wasm-opt)的体积——再次印证发布后 hash/体积都会变。`agent_budget` 与 `escrow` 两处构建上下文产出的 `escrow.wasm` hash 完全一致,说明构建确定。

## 4. 引擎版本覆盖边界（本机只有 0.47 swarm）

本机运行的 swarm 是 **walletd 0.47.0**（localnet，:12010）;**没有 0.49 的 swarm 二进制**,立不起 0.49 的真链环境。因此 live e2e 的覆盖如下:

| 维度 | 0.49（主网同代） | 0.47（本机 live swarm） |
|---|---|---|
| cargo test（in-process wasmer） | ✅ §2,99/0 | — |
| 参考 WASM hash | ✅ §3 | — |
| live e2e: 确认付款 + 超额拒绝 | 归 compat 会话的 0.49 swarm（见下） | ✅ `e2e_onchain_pay`:vault−500 / merchant+500,超额被链上 `TemplateError: Amount exceeds the per-transaction cap` 拒绝 |
| live e2e: admin（set_limits/remove_merchant） | 归 compat 会话 | ⚠️ 失败:`Invalid param 'manifest' … Invalid macro name` —— **master 的 SDK 讲 0.49 manifest 方言,0.47 swarm 的解析器不认**(pay 路径的宏未变故通过)。**这是客户端方言 vs 引擎版本的不匹配,不是模板 bug**;需版本匹配的 swarm 才能验证 admin 路径。 |
| live e2e: `pay_via_escrow` | 归 compat 会话 | 未跑（同样受 0.49/0.47 方言限制,且需 live escrow 地址） |

**结论**:本机能给出的冻结主证据是 **0.49 cargo test 全绿 + 可复现参考 hash**(§2/§3),这是与主网同代引擎的权威证据。**0.49 的 live 真链 e2e(pay/admin/escrow + key→session)必须在 0.49 swarm 上跑**——按 readiness P0 #1 属 `ootle-049-compat` 会话;本机 0.47 swarm 仅给出 pay 路径的旁证。

## 5. 真正「冻结 OK」还差什么

- [ ] `ootle-049-compat` 会话在 **0.49 本地 swarm** 上跑通三条 e2e（pay / admin / escrow）+ key→session 真链(readiness P0 #1)。
- [ ] 主网发布日(≈11-12)记录**发布后**的 `binary_hash`(post-wasm-opt,模板地址输入)到 `docs/mainnet.md`——那才是最终 hash。
- [x] 0.49 cargo test 全绿（本文 §2）。
- [x] 参考 WASM hash 固定（本文 §3）。
- [x] C-5 升级规则已定 immutable（`docs/mainnet-params.md` §0）。
