# tari-ootle 0.49.x 兼容性报告（v0.47.0 → v0.49.2）

> 写于 2026-11-02。上游当天连发 **v0.48.0 / v0.49.0 / v0.49.1 / v0.49.2**（均 pre-release）。前三个的
> **Linux 二进制构建失败**（release 页面只有 ffi / ledger / Windows exe），v0.49.2 是"0.47 之后第一个带二进制的版本"，
> 内容 = 0.48.0 + 0.49.0 + 0.49.1 + 一个构建修复（#3259）。所以本仓库的目标版本写作 **0.49.x = v0.49.2**：
> 二进制 `tari_ootle-0.49.2-aa7b0c8-linux-x86_64.zip`（sha256 `ec8053f3…5d280`），配套 crate
> `tari_template_lib` **0.37.0** / `tari_template_test_tooling` **0.49.2** / `tari_ootle_template_build` **0.17.1**、
> `tari_ootle_transaction` **0.49.2** / `tari_template_lib_types` **0.36.0**、`tari-ootle-cli` **0.34.1**，
> L1 配套 minotari **6.3.0-pre.2**（`tari_suite-6.3.0-pre.2-esme-e5635bf-linux-x86_64.zip`，0.47 用的是 6.2.0-pre.2）。
>
> 配套文档：`docs/mainnet-readiness.md`（主网 9 天计划）、`docs/devnet.md`（本地链搭法）、`docs/esmeralda.md`。

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 三个模板 | 只需 **两处源码级改动**（`XTR` 常量改名、测试里 owner 徽章调用加授权窗口）+ 依赖版本号。agent_budget **28/28**、escrow **26/26**、otc_board **45/45** 在 0.37 / 0.49.2 工具链上全绿；三模板已发布到 0.49 本地 swarm，三条真链 e2e + `/api/v1` key→session 流程全部通过（§5）|
| `pay` / `pay_via_escrow`（proof 作参数） | **不受授权窗口影响**：传给方法的 proof 在 0.49 里是"被出示"(shown) 的，模板仍可 `assert_resource` / `get_non_fungibles`；只有 **owner 徽章门控的方法**（`set_limits`/`issue_agent_badge`/…）需要调用方开窗口 |
| Python SDK / TS 客户端 | manifest 两处变化：`XTR` 关键字 → `TARI`（0.47 也认，无条件切换）；owner 调用包 `authorize!(proof)` … `drop_authorize!(proof)`（0.47 解析器不认这两个宏，所以是**可切换的方言**：默认 0.49，`AGENTPAY_PROOF_WINDOWS=0` / `proof_windows=False` / `{ proofWindows:false }` 回到 0.47）。单测 Python 77 / TS 20 全绿 |
| `scripts/esme-fund` | 升到 0.49.2 crate **零源码改动即可编译**：`main_signer` 默认 `SealSigner`（#3019），sr25519 封签由 walletd 完成（#3069）；但它依赖的 Caravel 水龙头组件会随 esmeralda reset 消失，见 §4 |
| 仪表盘 / `/api/v1` | 服务器不自己拼 manifest，全部走 `clients/ts/dist`——**dist 必须重建**后 0.49 才生效（本任务按要求不碰 dist；验证用的是本地盘上重建 dist 的仪表盘副本） |
| esmeralda | **两次 testnet reset**（0.48 #3063、0.49 #3195）：现有 esmeralda 地址（`template_88b11261…`、`template_11dc03f7…`、账户 `STBZ`、水龙头 `component_568f84a0…`）**全部失效**，钱包要 `tari_ootle_walletd reset`，模板重发、账户重新充值 |
| 0.47 环境 | 仍可用：0.47 swarm（:12010）/ 当前 esmeralda 走 `AGENTPAY_PROOF_WINDOWS=0`（三条 e2e 在 0.47 swarm 上用该方言实测通过）；但模板源码已升到 template_lib 0.37，**不能再发布到 0.47 链**（要发旧链用 `git stash` 前的 Cargo.toml） |

## 1. 变更 → 对本仓库的影响

| 上游变更（PR） | 影响面 | 结论 / 我们做了什么 |
|---|---|---|
| **proof 只在显式窗口内授权，窗口只借一跳**（#3199 加 `AuthorizeProof`/`DropProofAuthorization` 指令，#3206 引擎模型）| 所有 **owner 徽章门控**的方法调用：manifest 里 `create_proof_for_resource` 后的 proof 不再自动授权 | SDK/TS/测试里 owner 调用改为 `create_proof → authorize!(proof) → 调用 → drop_authorize!(proof) → drop_all_proofs!()`；窗口"借一跳"正好覆盖 AgentBudget 组件帧（含其内部 `issue_agent_badge` 的 mint 规则 `rule!(resource(owner_badge))`）。**`pay`/`pay_via_escrow` 不用开窗口**：proof 作为参数只是"出示"，模板只读它（`assert_resource`/`get_non_fungibles`），引擎允许；`pay_via_escrow` 跨模板调 `Escrow::new` 是 `allow_all`，也不需要任何授权 |
| **公钥 badge 只授权所盖的 frame**，删掉 `get_main_signer_proof` / `get_owner_proof` / `create_ownership_proof`（#3190）| Escrow / OtcBoard 用 `CallerContext::transaction_signer_public_key()` 做身份判断 | 该 API **保留**，三模板都没用被删的 getter → 无改动。注意：顶层直接调用 `escrow.release()` 时签名者 badge 在 Escrow 帧里有效；若将来经由别的组件转调，签名者身份不会传递（设计如此） |
| **模板升级改为 opt-in**（#3195，`ComponentHeader.upgrade_rule`，默认 `Locked`）| `agent_budget` 的 `new()` 现设 `.with_upgrade_rule(AccessRule(owner badge))`（owner 可迁移预算组件到新模板）；`escrow` / `otc_board` 不设 → **实例一经创建永久锁定代码** | 见 §6.2 的主网决策；代码位置 `templates/agent_budget/src/lib.rs` `new()`、`templates/escrow/src/lib.rs` `new()`、`templates/otc_board/src/lib.rs` `new()` |
| **交易签名改标准 sr25519**（#3069）、**显式主签名者**（#3019）、**客户端必须发全字段**（#3077：`main_signer` 只接受 `"None"`/`"SealSigner"`/`{"Authorizer":…}`，`blobs`/`nonce` 必填）| 只影响**自己构造 `UnsignedTransaction` 的代码** = `scripts/esme-fund`；SDK/TS/仪表盘全走 `transactions.submit_manifest`，由 walletd 封签 | esme-fund 的 `Transaction::builder(..).build_unsigned()` 在 0.49.2 crate 上原样编译：builder 默认 `MainSigner::SealSigner` 并序列化全部字段；`transactions.submit` 请求形状不变（`seal_signer: {"Derived":{"index":0,"key_branch":"account"}}`，新增字段 `detect_inputs_use_unversioned` 有默认值）|
| **废弃别名删除：`XTR` → `TARI`/`TARI_TOKEN`**（#3076）| 模板源码 `XTR` 常量（otc_board 的质押币种断言）、57 处测试、SDK/TS/脚本 manifest 里的 `XTR` 关键字 | 模板改 `TARI_TOKEN`；manifest 一律写 `TARI`（0.47 解析器 `"XTR" \|\| "TARI"` 都认，0.48+ 只认 `TARI`），API 层的 `resource="XTR"` 名字保留 |
| **创建已存在 substate 报 Conflict**（#3128）| `revoke_session` 后同名 badge 不能重铸 | 行为与此前一致（已在 api.md 记录"重新启用铸下一代 `key-<id>.2`"），错误类型从 panic 文案变为 `Conflict`——客户端不依赖文案 |
| **模板 metadata hash 改为不透明字节、不可为空；binary_hash 提交 value hash**（#3108/#3109/#3136）| `tari publish` 产物格式 | 需用配套 CLI **tari-ootle-cli 0.34.1**（11-02 发布）；0.47 链上的模板地址不会在 0.49 链上复现，必须重发 |
| **ProtocolVersion 收缩为 V0 + testnet reset**（#3063）、组件头加 upgrade_rule 再 reset（#3195）| esmeralda 全部状态清零 | 见 §3 |
| **indexer 以 CBOR blob 提供 substate/receipt/event**（#3101/#3110）| 直连 indexer REST 的客户端 | 我们全部经 walletd JSON-RPC（`substates.get`、`transactions.get_result`）读，walletd 仍返回 JSON 树 → 无影响（待 e2e 实测确认 `_find_component_state` / 事件解析不变）|
| **费率**：新建 substate 250 µT、声明输入计费、**release-scheduled fee scale**（#3012/#3060/#3078）、授权按规则节点计费（#3207）| 每笔 pay 的手续费、发布费 | 0.49.1 所有网络 scale = `FeeScale::ONE`（10 000 bps = ×1.0，`crates/engine_types/src/fees/fee_scale.rs` `activations()`），费率表所有网络共用一张（`applications/tari_ootle_app_utilities/src/fee_tables.rs`）；SDK `max_fee` 200 000 µT 的余量足够（待 e2e 读 `required_fees` 确认）|
| **walletd**：`PayRef`→`DestinationTag`、`value_summary`→`value_summaries`、`webauthn.auth_start` 不带 username（#3140/#3124/#3064）、首个 passkey 需启动打印的 setup token（#3114）、cookie 文件鉴权（#3113）、`transactions.get_all` 删除、主机名白名单（#3066）| 我们用 `auth=none` + `auth.request` 换 Admin token、`transactions.list`、只绑 loopback | 无影响；esmeralda walletd 若改用 WebAuthn 要注意 setup token |
| **钱包默认 `indexer_trust = "trust"`**（#3161）| 之前要手动 `-p ootle_wallet_daemon.indexer_trust=trust` | 现在是默认；主网建议显式 `verify` |
| **资源 auth hook 组件必须声明为输入**（#3188）| 我们没有 auth hook | 无影响 |
| **L1 配套**：minotari crates 6.3.0-pre.2（#3178）| 本地 swarm 的 L1 二进制 | 0.49 swarm 用 `tari_suite-6.3.0-pre.2-esme`；0.47 swarm 继续 6.2.0-pre.2，两套互不干扰 |

## 2. 改了什么（文件清单）

- `templates/*/Cargo.toml`：`tari_template_lib 0.37`、`tari_template_test_tooling 0.49`、`tari_ootle_template_build 0.17`（`Cargo.lock` 在 WSL 重新解析后回拷）。
- `templates/otc_board/src/lib.rs`：`stake.resource_address() == XTR` → `TARI_TOKEN`（文案不变）。
- `templates/*/tests/*.rs`：`args![XTR` → `args![TARI_TOKEN`；owner 徽章门控的调用在 `.put_last_instruction_output_on_workspace("proof")` 后加 `.authorize_proof("proof")`（agent_budget 15 处、otc_board 12 处；escrow 是签名者身份鉴权，0 处）。`pay`/`pay_via_escrow` 的调用**故意不加**，以证明"出示即可"。
- `sdk/src/agentpay/onchain.py`：`_NATIVE_KEYWORD = "TARI"`；`OnChainBudget.proof_windows`（默认 `_proof_windows_default()` 读 `AGENTPAY_PROOF_WINDOWS`）；`_owner_proof_open()/_owner_proof_close()` 统一三处 owner manifest（`withdraw`/`issue_agent_badge`/`_owner_call`）。
- `clients/ts/src/budget.ts`：同上（`proofWindows` 选项 + `ownerProofOpen()/ownerProofClose()`），新增 `budget.authz.test.ts`；`budget.resource.test.ts` 断言改 `TARI`。**`dist/` 未重建**（按任务约束），主会话需在本地盘 `npm test` 后回拷 `dist/*.js`+`*.d.ts`。
- `sdk/tests/test_onchain.py`：资源测试改 `TARI`；新增 4 个窗口方言测试。
- `scripts/otc_demo.py`、`scripts/call-escrow.py`：`withdraw(XTR,` → `withdraw(TARI,`；`scripts/otc_stake_demo.py` 另加 `authorize!(p)`/`drop_authorize!(p)`（OtcBoard 已冻结，只保证演示脚本不过时）。
- `scripts/esme-fund/Cargo.toml`：`tari_ootle_transaction =0.49.2`、`tari_template_lib_types =0.36.0`（源码未变）。
- 本文、`docs/HANDOFF.md` §6、README 版本号。

## 3. esmeralda 将 reset：现有地址全部失效

0.48 和 0.49 都是"testnet reset release"（验证节点/索引器/钱包数据目录全删、genesis 变）。官方升级说明：钱包执行 `tari_ootle_walletd reset`，模板"rebuild and republish against `tari_template_lib` 0.37"。对我们意味着：

- `docs/esmeralda.md` / `docs/environments.md` / README 里的 esmeralda 地址（agent_budget `template_88b11261…`、escrow `template_11dc03f7…`、otc_board `template_bafbe76e…`、预算 `component_2a785e3f…`、账户 `STBZ` = `component_63d78f7d…`）在 reset 后**不存在**；`web/server/state.esmeralda.json` 要换新文件。
- 账户要重新充值：Caravel 水龙头 `component_568f84a0…` 也是链上组件，reset 后没了；0.49.1 的内置 `XtrFaucet` 只有 `take(component)`（往**已存在**的账户里存 1000 TARI，`accounts.create_free_test_coins` 走的就是它，testnet 可用），不再有"给不存在账户建号+充值"的 bucket 版方法。所以 `scripts/esme-fund` 的"claim → 从 bucket 付费 → CreateAccount"路径在新 esmeralda 上要看官方是否重新部署水龙头模板；备选是 L1 burn → L2 claim（§6.3，esmeralda 要 100 个 L1 确认）。
- esmeralda 的 walletd 公网 indexer 默认已改为 `https://esme-indexer-{a,b}.ootle.tari.com/`（#3027）；旧的 `ootle-indexer-b.tari.com` 不要再写。
- 重发顺序和费用：escrow 先、agent_budget 后（`configure_escrow` 要 escrow 地址），`--max-fee` 按 dry-run 的 `required_fees`×1.2。

## 4. 0.47 环境仍可用（以及什么不能再做）

- **本地 0.47 swarm（:12010）与当前 esmeralda（:5100）**：SDK/TS/仪表盘加 `AGENTPAY_PROOF_WINDOWS=0` 即可继续跑（`TARI` 关键字 0.47 也认）。三条 e2e 和 `make e2e` 在 0.47 上要带这个变量。
- **不能再做**：用升级后的模板源码发布到 0.47 链（template_lib 0.37 产物只能上 0.49 链）；esmeralda reset 后对旧地址的任何读写。
- 两套本地链并存的布局：0.47 在 `/root/ootle/swarm`（端口 12000 段、webui 8080），0.49 在 `/root/ootle49/swarm`（`init --start-port 13000 --webui-listen-address 127.0.0.1:8081`，walletd **:13010**、indexer :13008），二进制、数据目录、钱包密钥完全分开；脚本在 `I:\wsl\setup\c49-*.sh`（`c49-swarm.sh install|init|start|status`、`c49-fund.sh`、`sync-and-test-templates49.sh`、`c49-detach.sh`/`c49-tail.sh`）。

## 5. 0.49 本地 swarm 验证状态

| 步骤 | 状态 | 证据 |
|---|---|---|
| 0.49.2 二进制 sha256 校验 + L1 6.3.0-pre.2 | ✅ | `tari_ootle-0.49.2-aa7b0c8-linux-x86_64.zip: OK`（`c49-swarm.sh install`）|
| 独立 swarm init（13000 段）| ✅ | walletd :13010 `settings.get` → `network {byte:16,name:localnet}`，webui :8081 |
| agent_budget `cargo test`（0.37 / 0.49.2）| ✅ 28/28 | 3 + 10 + 15（conservation / escrow_integration / test）|
| escrow `cargo test` | ✅ 26/26 | 4 + 4 + 4 + 14 |
| otc_board `cargo test`（45）| ✅ 45/45 | 22 + 4 + 19（test / conservation / authz），`cargo clean` 后从零编译（崩溃留下的半截 rlib 会报 `can't find crate for unicode_width`）|
| tari-ootle-cli 0.34.1 安装（`/root/ootle49/cli`）| ✅ | `cargo install -j 3 tari-ootle-cli --version 0.34.1 --root /root/ootle49/cli`，`tari --version` = 0.34.1 |
| 三模板发布到 0.49 swarm | ✅ | `c49-publish.sh escrow agent_budget otc_board`（CLI 0.34.1，`-n localnet -a default`）：escrow `template_f4c323fcd0c05aef17f9d4070e2e97dbecd969eca7633aebdae5af52025eac82`、agent_budget `template_1dc1be007640fb813f85f67d8a262d7b453f20f1e014c83013c5e964dcc00c0c`、otc_board `template_50705dbcf225f682d81ff1ca5117de99788f6f68bccdddca9cd5f14673fc8104`。注意 `start -k` 会跳过验证节点注册，第一次必须不带 `-k` 起（否则 epoch 卡 0、`No committee VNs found`）|
| `e2e_onchain_pay.py` / `_admin.py` / `_escrow.py` | ✅ 3/3 | `WALLETD_URL=http://127.0.0.1:13010/json_rpc AGENT_TEMPLATE=template_1dc1be00… ESCROW_TEMPLATE=template_f4c323fc…`（默认 0.49 方言）：pay 500 确认 + 超限被验证节点拒（`Amount exceeds the per-transaction cap`）；remove/add_merchant、set_limits、日上限全部链上生效；`pay_via_escrow` 400 → escrow 组件 → release 380/fee 20。同一批脚本在 0.47 swarm 上加 `AGENTPAY_PROOF_WINDOWS=0` 也 3/3 通过 |
| `/api/v1` key→session 真链流程 | ✅ | 仪表盘副本（本地盘，重建后的 dist）`PORT=8799`、独立 `AGENTPAY_STATE_FILE`/`TXLOG_FILE`、`AGENTPAY_API_KEYS=admin:ops:…,agent:bot1:…`，连 :13010：`POST /budgets` 201 → 未发 badge 的 key 付款 201（session=default）→ `POST /keys/bot1/session` 201（owner 徽章 `issue_agent_badge` 走 `authorize!` 窗口）→ 付款 201 receipt.session=`key-bot1` → 超限 402（仪表盘客户端预检先拦；链侧同一上限由 e2e 证明）→ `POST /keys/bot1/session/revoke` 200 → 付款 **403**「on-chain session revoked」→ 重发得 `key-bot1.2`（generation 2，#3128 Conflict 下不能重铸同名）→ 付款 201 session=`key-bot1.2` |
| esme-fund 0.49.2 构建 | ✅ | `cargo build` Finished（WSL `/root/ootle49/esme-fund`）|
| esme-fund dry-run（0.49 walletd :13010）| ✅ 格式/签名路径通过 | 产物 JSON 键 = `blobs, dry_run, fee_instructions, inputs, instructions, main_signer("SealSigner"), max_epoch, min_epoch, network, nonce`；`transactions.submit_dry_run`（`seal_signer` Derived index 1 = default 账户）被 walletd 接受并封签、引擎执行到第 1 条指令后拒：`Function claim not found`、`required_fees: 331`——localnet 没有 Caravel 水龙头，这正是预期的失败点，说明 0.49.2 的交易编码 + 主签名者 + sr25519 封签全部兼容。真正充值要等新 esmeralda 的水龙头地址（§3）或走 burn→claim（§6.3）|

## 6. MainNet 准备

> 主网 2026-11-11（`docs/mainnet-readiness.md` §0）。下面每条都给出 0.49.1 源码位置，便于主网版本发布后复核。

### 6.1 网络名、genesis、协议版本、费率、端点

| 问题 | 结论（0.49.1 源码）|
|---|---|
| `--network` / `tari publish -n` 的取值 | `crates/ootle_network/src/lib.rs`：`mainnet`(0x00) · `stagenet`(0x01) · `nextnet`(0x02) · `localnet`(0x10) · `igor`(0x24) · `esmeralda`/`esme`(0x26)。主网就是 **`mainnet`**，网络字节 **0**（esme-fund 的 `network_byte` 参数填 0）。`Network::is_testnet()` 对 MainNet 返回 false |
| genesis 治理委员会（#3026）| `applications/tari_ootle_app_utilities/src/genesis_governance.rs`：MainNet 委员会**固定在发布里**（threshold 1，单成员 `9a05fef0…8b19`），配置文件里再配会被拒（`ConfiguredOnMainNet`）；主网 burn rate 自 epoch 0 由该委员会治理。对我们没有操作项，只说明主网参数由 Tari 团队单签控制 |
| ProtocolVersion | #3063 后所有网络只有 **V0**（`crates/engine_types/src/protocol_version.rs`），主网 genesis 从 V0 起；没有"主网专用协议版本"要配 |
| 费率表 | `applications/tari_ootle_app_utilities/src/fee_tables.rs` `get_fee_table_by_network()`：**所有网络（含 MainNet）共用一张表**（注释："MainNet shares it with the testnets until its economics are modelled"）。关键数字：每字节存储 1 µT、新建 substate 250 µT、模块调用 1 µT、wasm 1 µT/1000 点、模板加载 10 µT/3 KB、**发布费 = 250 000 µT 固定 + 字节费 + 超过 96 KiB 部分按 (超出 KiB)² × 100 µT 的二次方溢价**、声明输入按字节 1/64 计费 |
| 发布计划费率（#3078）| `crates/engine_types/src/fees/fee_scale.rs` `FeeScaleSchedule::activations()`：**每个网络（含 MAINNET）当前都是 `(Epoch(0), FeeScale::ONE)` = 10 000 bps = ×1.0**。后续版本可以在某个 epoch 把主网 scale 调大，所以主网 dry-run 的 `required_fees` 才是准数；发布前先 `transactions.submit_dry_run` |
| 对我们的费用估算（scale ×1）| agent_budget 244.9 KiB：超出 96 KiB ≈ 149 单位 → 149²×100 ≈ 2.22 M µT + 固定 0.25 M + 字节 0.25 M ≈ **2.7 TARI**；escrow 156.1 KiB：60²×100 = 0.36 M + 0.25 M + 0.16 M ≈ **0.8 TARI**（esmeralda 实测 3.47 / 1.35 tTARI，与此量级一致，差额是加载/执行费）。一笔 `pay`：≈ 模块调用 + 事件 + 两个 vault 更新，esmeralda 上 < 0.01 tTARI；SDK `max_fee=200 000 µT` 余量在 ×1 下足够，若主网把 scale 调到 ×3 仍够，再高要调 |
| indexer / walletd 主网默认端点 | **没有写死也没有公布**：walletd 配置只有 esmeralda 预设 `config_presets/e_wallet_daemon.toml` → `https://esme-indexer-{a,b}.ootle.tari.com/`；`crates/wallet/ootle-rs/src/helpers.rs::default_indexer_url(MainNet)` 是 `unimplemented!("MainNet indexer URL is not set")`。主网 walletd 必须显式 `-p ootle_wallet_daemon.indexer_api_url=[...]`，端点等官方公布；`indexer_trust` 主网用 `verify`（#3161 后默认 `trust`）|
| 主机名白名单（#3066/#3087）| walletd / VN 只接受 localhost、IP 或 `allowed_hosts` 里的主机名；仪表盘前面放反向代理时要把域名加进 walletd 的 `allowed_hosts`（我们的仪表盘走 127.0.0.1 直连 walletd，不受影响）|

### 6.2 模板升级 opt-in（#3195）：主网发布后还能不能升级？

**机制**（`crates/template_lib/src/component/instance.rs`、PR #3195）：
- 升级的粒度是**组件实例**，不是模板。`UpdateComponentTemplate` 指令把一个组件指向新模板（可带 migrate），校验的是该组件头里的 `upgrade_rule`（创建时固定，**永不可改**）：
  - `UpdateRule::Locked`（**默认**，包括构造函数返回 `Self` 的组件）→ `ComponentUpgradesLocked`，谁都不能升；
  - `UpdateRule::Owner` → 看当前 owner rule（`OwnedBySigner` 组件就是创建者密钥；无 owner 的组件等于锁死）；
  - `UpdateRule::AccessRule(r)` → 任意访问规则（如 owner 徽章资源、多签），与 owner rule 无关。
- 设置方式：`Component::new(state).with_upgrade_rule(UpdateRule::...)...create()`。
- **模板本身**（`template_xxx` 地址）永远不可变：新代码 = 新模板地址 + 对已有组件做 `UpdateComponentTemplate`（迁移帧受限：只能改自己的状态，不能动 vault/调用别人，#3206）。

**我们的现状（2026-11-03 更新）**：`agent_budget` 的 `new()` 现调 `.with_upgrade_rule(UpdateRule::AccessRule(rule!(resource(owner_badge))))` → 预算组件可由 owner 徽章持有者经 `UpdateComponentTemplate` 迁到新模板；`escrow` / `otc_board` 的 `new()` 不调 → 实例创建即 `Locked`。模板发布后都可随时发新模板，但 **escrow 的已开组件无法迁移**（owner 只能 `withdraw` 剩余、用新模板重新 `open`），**agent_budget 的已开组件可由 owner 原地迁移**（额度/会话状态保留）。

**最终决策（2026-11-03,已拍板,采纳下面的建议 1+2,取代先前「均保持 immutable」的决策）：`agent_budget` 组件实例以 `upgrade_rule = AccessRule(owner badge)` 发布(`new()` 调 `.with_upgrade_rule(UpdateRule::AccessRule(rule!(resource(owner_badge))))`)—— 仅 owner 徽章持有者可经 `UpdateComponentTemplate` 把自己的预算迁到修正后的新 agent_budget 模板,agent 徽章不能;`escrow` 与 `otc_board` 保持 `Locked`(immutable)。** 理由:AgentBudget 逻辑复杂(额度/窗口/白名单/会话/撤销),主网若发现模板 bug,owner 原地迁移比「提款→发新模板→重开→refund→重发 badge」成本低得多,且升级权锁死在 owner 徽章(agent 徽章不能升)、迁移帧引擎受限(#3206 不能碰 vault/外呼);Escrow 的不可变是其资金托管担保,保持 Locked(且 Escrow 无 owner 徽章,`Owner` 规则会落到创建者密钥=AgentBudget 组件,语义不对,见建议 2)。owner-key 失陷的爆炸半径从「提走余额」扩大到「可把预算迁到新模板」——但新模板仍须 owner 自己发布、内容寻址可审计,非任意改写。**限制:**enforcement 测试(owner 能升/agent 不能升)暂无法写——test_tooling 0.49.2 未暴露驱动 `UpdateComponentTemplate` 的 API,依赖现有 28 测试做回归,主网/0.49 CLI 待核一次实际迁移。改动已做:`agent_budget/src/lib.rs` `new()` 新增该行,28/28 cargo test 仍绿(行为不变),新 WASM hash 见 `docs/template-freeze.md` §3。权威记录见 `docs/mainnet-params.md` §0。

**原决策建议（主网前必须拍板,保留备查）**：
1. **AgentBudget 加 `.with_upgrade_rule(UpdateRule::AccessRule(rule!(resource(owner_badge))))`**——只有持 owner 徽章的人能把自己的预算迁到新模板，agent 徽章不能。代价：一行代码 + 一个测试（agent 持 agent 徽章尝试 `UpdateComponentTemplate` 必须被拒；owner 能迁）。收益：主网后修 bug 不用"提资金、重开、重发 badge"。这与"链是权威"不冲突：升级权仍归 owner。
2. **Escrow 保持 `Locked`**：托管期间代码不可变是卖点，而且 Escrow 没有 owner 徽章（身份鉴权），`Owner` 规则会落到创建者密钥，而创建者在 `pay_via_escrow` 路径下是 AgentBudget 组件，语义不对。
3. **OtcBoard 冻结，不上主网**（已有结论）。
4. 不管选哪条，**主网发布的模板代码就是最终版**：`docs/mainnet-readiness.md` §2 P0-4 的"模板冻结"要在加了 upgrade_rule 之后再做最后一轮测试。

### 6.3 主网 XTR 怎么来：L1 burn → L2 claim

链上没有主网水龙头。路径与 esmeralda 相同（`docs/esmeralda.md`、ootle.tari.com/guides/burn-minotari）：

1. **L1**：`minotari_console_wallet`（主网版）Burn：claim public key = **L2 owner 账户的 64 位 hex 公钥**（`accounts.list` 里的 `owner_public_key`，不是 `otl_…` 地址），Sidechain key 留空。主网需 **780 个 L1 确认（≈1 天）**，esmeralda 100 个。填错 key 资金永久丢失 → 先小额试。
2. **L2 walletd（0.49.x）**：
   - 自动：`auto_claim_burns = true`（`applications/tari_walletd/src/config.rs` `return_default_auto_claim_burns`，默认开）会监视 `burn_proof_dir`（默认 `~/.local/share/tari/<network>/burn_proofs`），L1 钱包导出的 burn proof JSON 放进去即自动提交 claim；
   - 手动 JSON-RPC（`applications/tari_walletd/src/server.rs` 分发表）：
     - `burn_proofs.list` / `burn_proofs.get { file_name }`：列出 / 读取目录里的 proof；
     - **`accounts.claim_burn`**：`{ "account": <名字或 component 地址>, "claim_proof": {"FromFile": {"file_name": "..."}} 或 {"Contents": {"claim_proof": <MinotariBurnClaimProof>, "encrypted_data": <EncryptedData>}}, "max_fee": "<µT 字符串>", "is_dry_run": true|false }` → `{ transaction_id, required_fees?, dry_run_result? }`（`clients/wallet_daemon_client/src/types.rs` `ClaimBurnRequest`；处理函数 `handlers/accounts.rs::handle_claim_burn → execute_claim_burn`，claim 交易自己声明 `TARI_TOKEN` 输入并由该账户的 owner key 封签）。先 `is_dry_run: true` 拿 `required_fees`，再真提交；
     - 到账后 `accounts.get_balances { account, refresh: true }`。
   - 账户必须**先存在于钱包**（`accounts.create`），链上不存在也可以：claim 交易会顺带创建（与 `create_free_test_coins` 对不在链上的账户的处理相同）。
3. 之后发布模板与开预算都从这个账户付费；预算本金小额、`top_up` 按需。
4. 工具：`scripts/esme-fund` 不适用于主网（它针对的是 esmeralda 的 Caravel 水龙头）；主网充值就是上面的 `accounts.claim_burn`，如需脚本化可以在 `scripts/esme_fund_submit.py` 的 auth/epoch 骨架上加 `accounts.claim_burn` 调用。

## 7. 环境踩坑（2026-11-02，这台机器）

- **WSL2 来宾反复崩溃**（Hyper-V-Worker 事件 18590 "guest OS reported a failure"，18:46–20:23 共 7 次）：每次前 1 秒 Windows System 日志都有 **Resource-Exhaustion-Detector 2004「虚拟内存不足」**，占用大头 vmmem 11–15 GB + ToDesk 2.3 GB；`Win32_OperatingSystem.TotalVirtualMemorySize` = 31.8 GB = 物理内存，`AutomaticManagedPagefile = False`——**宿主机没有页面文件**，commit 一满 Hyper-V 就无法给 VM 供页。触发场景是 cargo 并行编译 `tari_template_test_tooling`（20 核全开）叠加两套 swarm。处置：`C:\Users\39881\.wslconfig` 设 `memory=10GB` + `swap=12GB`（swap 在 vhdx 内，不吃宿主 commit；删文件即回退），cargo 一律 `CARGO_BUILD_JOBS=3`，编译期间停掉 0.49 swarm。**根治已做**：用户 20:47 开启了系统页面文件（commit 上限 31.8 → 36.6 GB 且按需增长）并重启，之后 otc_board 全量编译 + CLI 编译 + 发布三模板都没有再崩。主会话另外发现 wsl.exe 3.0.1.0 在 Y: 盘 cwd 下有栈溢出崩溃（已升级 3.0.3.0）；wsl.exe **一律从本地盘 cwd 调用**。
- **WSL 3.0.3.0 会在 wsl.exe 会话结束时回收 `setsid nohup` 起的孤儿进程**（`sleep 40` 探针 6 秒后即消失，3.0.1 不会）。所以长任务和服务要让 Windows 侧进程常驻：`Start-Process wsl.exe -ArgumentList '-d','ootle-dev','-u','root','--','bash','/mnt/i/wsl/setup/c49-job.sh','<tag>','bash','<job.sh>' -WindowStyle Hidden`（`c49-job.sh` 在前台跑作业并写 `/root/logs/<tag>.{log,exit}`），swarm 用 `c49-swarm-service.sh`（start 后 `exec sleep infinity`）。
- WSL2 的发行版只在有 wsl.exe 客户端会话时存活：长任务用 `setsid nohup`（`c49-detach.sh`）并另起 `wsl.exe -d ootle-dev -u root -- sleep infinity` 保活；两个会话共用一个发行版时，谁的保活先断谁就把所有进程带走。
