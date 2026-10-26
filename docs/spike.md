# Ootle 可行性调研（Phase 0 Spike）

> 调研原则：所有 API 结论都来自官方仓库 `tari-project/wasm-template` 的真实源码，不凭记忆。
> 每条结论标注**来源文件**，方便复核。日期：2026-10-21。

## 调研方式与证据来源

本机尚未安装 Rust 工具链（`rustc` / `cargo` / `rustup` / `tari` 均不存在），因此本 spike 的
API 结论来自**阅读官方仓库真实源码**，而非本地编译运行。参考文件：

- `examples/guessing_game/template/src/lib.rs` —— 访问控制、事件、Vault/Bucket、随机数
- `project_templates/nft_marketplace/templates/auction/src/lib.rs` —— **时间/epoch、托管/退款模式（最接近 Escrow）**
- `wasm_templates/stable_coin/src/lib.rs` —— **保密资源、badge+rule! 访问控制、recall**
- `wasm_templates/fungible/src/lib.rs` —— 基础 Vault/Bucket/Amount 用法
- docs.rs: `tari-ootle-cli` 0.10.0、`tari_template_lib`、`tari_template_abi`

> ⚠️ 未经本地编译验证的部分在文中标注「**待本地验证**」。客户端订阅事件、devnet 部署等需要
> 工具链 + Wallet Daemon 才能确认。

---

## 问题 1：模板里能否读取当前时间 / epoch？精度多少？

**能，但只有 epoch 粒度，没有墙上时钟时间戳。**

- API：`Consensus::current_epoch()`。
  来源：`nft_marketplace/.../auction/src/lib.rs` 在 `new`（设置 `ending_epoch`）、`bid`、`finish`、
  `cancel` 中都调用它。
- 精度：**epoch 约等于 30 分钟一个**（auction 源码注释明确说明团队在时间戳、基础层区块高度、epoch
  三者中选了 epoch，并注明 ≈30min）。
- 没有秒级/毫秒级时间戳，也没有直接读基础层区块号的用法出现在示例中。

**对设计的影响：**
- 「超时退款」= 存 `deadline_epoch`，`refund()` 里断言 `Consensus::current_epoch() >= deadline_epoch`。
- 「每日上限」**不能按自然日**，只能按 epoch 窗口近似。方案：存 `window_start_epoch` 和窗口长度
  `epochs_per_window`（例如 48 个 epoch ≈ 24h），`pay()` 时若 `current - window_start >= epochs_per_window`
  则重置 `spent_today = 0` 并前移窗口。文档和 UI 要讲清「每日」是「约24小时的 epoch 窗口」，不是午夜对齐。
- 精度 ≈30min 对托管超时足够；对「限速」类场景够用。

---

## 问题 2：保密（confidential）资源的金额，模板内部能不能读到？

**读不到明文金额。模板无法在内部解密一个保密承诺（commitment）的数值。**

证据（`stable_coin/src/lib.rs`）：
- 主稳定币用 `ResourceBuilder::confidential()` 创建。
- 模板**从不**解密保密金额。它只能：
  - 用 `ConfidentialOutputStatement::mint_revealed(...)` 铸造「已揭示」金额；
  - 用 `ConfidentialWithdrawProof::revealed_withdraw(amount)` 从保密 Vault 取出「已揭示」金额；
  - 用 `count_confidential_commitments()` 断言为 `0`（即只接受 revealed 部分，拒绝隐藏承诺）；
  - 对 Bucket 调 `amount()` 读到的是**已揭示**部分的金额。
- 源码里有 TODO 明确写：目前**无法**在「不创建 revealed proof」的情况下从保密资源取款。

**结论：链上限额检查（单笔上限/日上限/白名单金额）无法作用于「隐藏的」保密金额。**

三个方案的利弊（对应计划书 a/b/c）：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **(a) 代理钱包内用明文资源，仅对外转账保密** | AgentBudget 的 vault 持有 `public_fungible` 稳定币，限额对明文金额强制；若最终收款方要保密，由商户侧/下游转换 | 限额 100% 链上可验证；实现最简单 | 预算账户余额公开可见（隐私弱） |
| **(b) 依赖范围证明 / revealed 金额** | 要求每笔 `pay` 带 revealed 金额（`count_confidential_commitments()==0`），对 revealed 部分做限额 | 保留保密资源类型；限额仍可链上校验 | 代理每笔必须揭示金额 → 该笔金额公开，等于「限额可见、余额保密」；证明构造复杂 |
| **(c) 限额只针对明文稳定币** | 产品规定：带限额的预算只支持明文稳定币；要完全保密则不加链上限额 | 语义清晰、最稳妥 | 功能上「隐私」与「硬限额」二选一 |

**推荐：Phase 2 的 AgentBudget 先走 (a)**——vault 用明文可替代资源（stable_coin 的 `public_fungible`
分支已证明可行），限额对明文金额强制。这不违背「不绑定单一币种」：只要求「该资源为明文可数金额」。
**Phase 4 的隐私 P2P 托管**里，被托管资产可以是保密资源，但「金额上限/保证金」这类硬约束要落在
revealed 金额或明文保证金上（方案 b/c 混合）。

> ⚠️ 这条结论**部分推翻**了「限额天然作用于任意保密币」的朴素设想。按计划书要求，已在此标出，
> 建议采纳方案 (a) 作为 Phase 1/2 的基线，不阻塞后续开发。

---

## 问题 3：访问控制怎么做——badge + `rule!` 还是 `CallerContext`？

**两者都存在，推荐 badge（NFT 凭证）+ `rule!` 为主，`CallerContext` 作辅助识别。**

证据：
- **badge + `rule!`（stable_coin）**：
  - 实例化时铸造 non-fungible 管理员 badge；`require_admin = rule!(resource(admin_resource))`。
  - 用户 badge：`require_user = rule!(any_of(resource(admin_resource), resource(user_auth_resource)))`。
  - 组件级 `AccessRules`：按方法设规则，默认 `require_admin`，个别方法 `AllowAll`。
  - `OwnerRule::None` + 资源铸造/销毁/`recall` 需要 admin badge；`recall_tokens` 可强制召回用户账户里的承诺。
- **方法级规则（guessing_game）**：默认组件方法仅 owner 可调；
  `ComponentAccessRules::new().method("guess", rule![allow_all])` 单独放开某方法。
- **`CallerContext`（guessing_game）**：`CallerContext::transaction_signer_public_key()` 取签名者公钥用于
  业务识别（记录是谁猜的），**不是**访问控制门禁。

**对设计的影响：**
- Escrow / AgentBudget 的「仲裁人」「所有者」「代理」身份 → 用 **non-fungible badge** 表示，方法用
  `rule!(resource(xxx_badge))` 守门。`new()` 返回 owner_badge / agent_badge（与计划书一致，已被 stable_coin 的
  多 badge 模式证明可行）。
- 「撤销代理」可用两种实现：(1) 组件里存 `revoked: bool` 标志，`pay()` 先断言未撤销；(2) 更强的用
  `recall` 把 agent badge 召回/拉黑（stable_coin 的 `blacklist_user` 即此模式）。Phase 2 先用标志位，简单可测。

---

## 问题 4：调用另一个组件（跨模板调用）的写法

**用 `invoke(method, args![...])` 向目标组件/地址发起调用；资源管理器用 `get_resource_manager()`。**

证据：
- `guessing_game`：把奖品 Bucket 发给赢家账户用 `invoke("deposit", args![prize])`。
- `auction`：结算时把资金/ NFT `invoke("deposit", args![...])` 存入卖方/买方账户；取款用
  `vault.withdraw_all()` / `vault.withdraw(amount)` 得到 Bucket 再 invoke 存入。
- 资源操作：`vault.get_resource_manager()` 后 `mint_non_fungible(...)` / `total_supply()` 等。

**对设计的影响：**
- `AgentBudget::pay_via_escrow(...)` 可以在模板内部**创建/调用** Escrow 组件：把资金 `withdraw` 成 Bucket，
  再 `invoke` 到新建的 Escrow 组件的入金方法。**待本地验证**：跨模板「实例化新组件」的确切 API（示例里
  见到的是对已存在组件/账户的 `invoke`；新建另一模板实例的调用形态需编译期确认，Phase 1 做 Escrow 时一并验证）。

---

## 问题 5：事件 `emit_event` 用法，客户端怎么订阅

**链上侧已确认；客户端订阅侧待工具链/indexer 验证。**

链上（已确认）：
- 用法：`emit_event("EventName", metadata![...])`，参数是事件名 + 一组键/字符串对。
  - `guessing_game`：`emit_event("GameEnded", metadata![winner, winner_account, number, num_participants])`。
  - `stable_coin`：大量事件 `increase_supply` / `withdraw` / `deposit` / `blacklist_user` 等，均带结构化字段。
- 注意：`auction` 示例**完全没用** `emit_event`，所以事件是可选的、按需加。
- 事件字段值是字符串化的 metadata；设计时把金额、商户、memo、escrow_id 等都塞进字段，方便客户端重建账本。

客户端订阅（**待本地验证**，Phase 3 落实）：
- Ootle 的事件随交易结果落账，客户端一般通过 **indexer / substate 扫描 + 交易回执** 读取事件，而非
  长连接 push。现有 `ootle-py`（ootle-agentpay）里查交易结果的通道即是订阅入口。
- Phase 3 接入时，需确认 `ootle-py` 是否已暴露「按组件地址拉取事件/交易」的接口；若没有，则退化为
  「提交交易后从回执读 events + 定期轮询组件状态」。

---

## CLI / 工作流现实校正（与计划书的差异）

计划书写的是 `cargo generate https://github.com/tari-project/wasm-template`，**这是旧手法**。
以下为**本机实际安装的 `tari-ootle-cli` 0.33.0** 的 `tari --help` 实测子命令（docs.rs 显示的 0.10.0
已过时，无 `add`/`gen`/`deploy` 别名）：

- 安装：`cargo install tari-ootle-cli`（二进制名 `tari`）。**仅 Linux**，见下方「平台」。
- 前置：Rust 工具链 + `wasm32-unknown-unknown` target；发布还需运行中的 **Tari Wallet Daemon**。
- 子命令（实测）：
  - `tari init` —— 在模板 crate 里初始化项目配置和模板元数据。
  - `tari create <name>` —— 从 starter 模板新建一个 Tari 模板 crate。
  - `tari build` —— 编译模板 WASM 二进制。
  - `tari lint` —— 检查 Rust lint、二进制体积、元数据问题。
  - `tari publish` —— 发布模板到网络（`-n/--network`，如 esmeralda/igor/localnet/mainnet；
    `--api-key` 对接 wallet daemon）。
  - `tari template` / `tari metadata` —— 模板元数据工具。
  - `tari config` —— 管理 `tari.config.toml`。
- **`tari --skill`** —— 输出一份教编码 agent 如何用本 CLI 的 Markdown 指南，可写成
  skill 文件（例：`tari --skill > .claude/skills/tari/SKILL.md`）。建议 Phase 1 前生成，作为 CLI 的权威参考。

> guessing_game 不是通过 `tari create` 的内建模板，而是官方仓库 `examples/guessing_game` 里的现成工程
> （含 `template/`、`cli/`、`tests/`）。Phase 0 跑通它 = `cargo test`（模板单测，用 wasmer 沙箱执行，
> 不需联网也不需 CLI）→ `cargo build --target wasm32-unknown-unknown --release` 产出 `.wasm`
> → 再 `tari publish` 到 devnet（需 Wallet Daemon）。

## 平台：必须用 Linux（WSL），不能用原生 Windows（实测结论）

- **模板测试**：`tari_template_test_tooling` → `tari_engine` 对 `wasmer` 写死 `features=["cranelift"]`
  （且用 fork 的 `tari-wasmer-middlewares`，metering/缓存都是 Cranelift 专用），而
  `wasmer-compiler-cranelift` 在 Windows 直接 `compile_error!("not supported on Windows")`。**不是改配置能换后端的**。
- **CLI**：`cargo install tari-ootle-cli` 在 Windows 还会卡在 `openssl-sys`（需 OpenSSL dev）和
  `wasm-opt-sys`（内置 binaryen，MSVC 编译失败）。
- 官方 CI（`.github/workflows/ci.yml`）只用 `ubuntu-latest`，印证面向 Linux。
- **本机已落地**：WSL2 + Ubuntu 24.04 + Rust 1.99.1 + wasm32 目标 + tari-ootle-cli 0.33.0。
  guessing_game `cargo test` 在 Ubuntu 通过（`test it_works ... ok`），并产出 150K 的
  `guessing_game.wasm`。仓库放在 WSL ext4（`/root/ootle/wasm-template`），不要在 `/mnt/f`（9p）上编译。

---

## Phase 0 结论

1. **时间**：只有 epoch 粒度（≈30min），超时退款可行；「每日上限」改为「epoch 窗口」近似。✅ 不阻塞。
2. **保密金额**：模板读不到隐藏金额——**这是唯一影响设计的结论**。建议 AgentBudget 限额走明文资源
   （方案 a），隐私托管的硬约束落在 revealed/明文保证金上。⚠️ 已按计划书要求标出，建议采纳后继续。
3. **访问控制**：non-fungible badge + `rule!(resource(...))` + 组件 `AccessRules`，模式成熟。✅
4. **跨组件调用**：`invoke(method, args![...])` 成立；「模板内新建另一个组件实例」的确切写法留待
   Phase 1 本地编译时确认。✅（1 处待验证）
5. **事件**：`emit_event(name, metadata![...])` 成立；客户端订阅在 Phase 3 用 `ootle-py` 落实。✅（客户端侧待验证）

**是否推翻后面的设计**：不推翻整体架构，但**保密金额限额**一条需要你拍板——按方案 (a) 把带硬限额的
预算限定为明文可数资源（仍不绑定单一币种）。确认后即可进入 Phase 1（Escrow）。

**交付物状态**：工具链已装好（WSL Ubuntu），guessing_game `cargo test` **已通过**，`.wasm` **已产出**。
唯一仍缺的是真正的 `tari publish` 上链——需运行中的 **Tari Wallet Daemon + devnet 连接/测试资金**，
这是目前暂无的部分（不阻塞 Phase 1 的本地开发与测试）。
