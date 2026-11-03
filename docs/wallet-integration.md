# 用户自带钱包、浏览器签名：AgentPay 网页能不能、怎么做（spike 结论）

> 问题：现在的仪表盘（`web/server` + `web/public`）是托管模式——所有用户共用服务器 walletd 里的一个 owner 账户。
> 能不能改成"用户用自己的 Tari/Ootle 钱包在浏览器里签名，后端只做只读索引和 API"？
> 本文给出有代码证据的答案、推荐方案与备选、阻塞项、可复用代码、多用户模型，以及 `web/` 逐文件改造计划。
> 原型代码在 [`web/spike/`](../web/spike/README.md)，2026-11-02 在本机 0.47 本地 swarm 上真实跑通。

## 0. 一句话结论

**能。** 两条"钱包侧签名"路径都在本地 swarm 真实完成了开预算 → 单枚 badge 证明付款 → 读到 `AgentBudget.pay` 事件 → 超限付款被链拒绝：

| 路径 | 私钥在哪 | 签名 | 本次链上 tx（前缀） |
|---|---|---|---|
| **A 浏览器密钥** | 浏览器（`SecretKeyWallet`，WASM sr25519） | 页面自己签，直接提交 indexer | open `6c3756b5…` / pay `863c78d4…`（浏览器）；open `c6f4ce84…` / pay `8cb721bc…`（Node） |
| **B 用户的 walletd** | 用户自己的 `tari_ootle_walletd` | 页面发**签名请求**，钱包主人批准，walletd 返回签名；页面封装、提交 indexer | open `907414a7…` / pay `2ad577ad…`（浏览器）；open `2ef036ba…` / pay `1cc9bd73…`（Node） |

**推荐：B（用户的 walletd 签名，页面构造+提交）**。它是 Ootle 官方 SDK（ootle.ts）唯一的"产品级"签名器路线：0.47 用 `signing_requests`（本 spike 已验证），0.48+ 用 `transactions.sign`（ootle.ts 0.12 的 `WalletDaemonSigner`）。
**A 作为备选/演示**（私钥明文在浏览器，适合低额试用或"一键体验"）。
**当前 Ootle 生态没有可供普通用户安装的浏览器扩展钱包**；旧 tari.js 的 MetaMask snap / WalletConnect / Tari Universe 签名器已冻结且 snap 包不在 npm（§1.1）。
所以"用户自带钱包"在今天的 Ootle 上 = **用户自己跑一个 walletd**（桌面/本机进程），这是对用户最大的要求，也是决定要不要走非托管路线的关键事实。

## 1. 调研：tari.js 现在是什么

### 1.1 两代 SDK

`github.com/tari-project/tari.js` 已重命名为 **`tari-project/ootle.ts`**（旧 URL 跳转），旧文档站 404。npm 上同时存在两代包：

| | 旧 **tari.js**（`@tari-project/tarijs` 0.14.6） | 新 **ootle.ts** 0.11.1 | 新 **ootle.ts** 0.12.0 |
|---|---|---|---|
| 最后发布 | 2026-08-24（之后没动） | 2026-10-23 | **2026-11-02**（当天） |
| 对应 Ootle | 0.4x 之前的网络 | **0.47.0**（本机 swarm） | **0.49.1**（升级说明覆盖 0.48/0.49 两次 testnet reset） |
| 包 | `tarijs`、`tarijs-builders`、`indexer-provider`、`wallet-daemon-signer`、`metamask-signer`、`tari-universe-signer`、`wallet-connect-signer`、`tari-permissions` | `ootle`、`ootle-indexer`、`ootle-secret-key-wallet`、`ootle-wallet-daemon-signer`（+ 外部 `ootle-wasm` 0.47.0、`ootle-ts-bindings` 1.60.0、`indexer-client` 1.11.0、`wallet_jrpc_client` 1.26.0） | 同左，`ootle-wasm` 0.49.1、新增 `ootle-wasm-bor` |
| 签名器 | walletd、MetaMask snap（`npm:@tari-project/wallet-snap`——**npm 404，不存在**）、Tari Universe（桌面 app 内 tapplet）、WalletConnect | `WalletDaemonSigner`、`SecretKeyWallet`、`OotleWallet`（多签名器） | 同左 |
| 权限模型 | `TariPermissions` 类（`AccountBalance`、`TransactionSend`…） | 直接传 walletd 的 `Permission`（默认 `["Admin"]`） | 同左 |

**没有**浏览器扩展、没有 MetaMask、没有 WalletConnect：ootle.ts 的 README、docs 和源码里都不存在；旧 tari.js 的那三个签名器针对的是已不兼容的网络，而且 snap 包不在 npm。

### 1.2 ootle.ts 的 provider / signer

| 角色 | 类 | 用户前置条件 | 作用 |
|---|---|---|---|
| **Provider**（读链 + 提交，不签名） | `IndexerProvider`（`ootle-indexer`） | 无需钱包；只要能访问一个 indexer REST（本机 `127.0.0.1:12008`，esmeralda `ootle-indexer-a.tari.com`） | `getSubstate`、`getCurrentEpoch`、`submitTransaction`（POST `/transactions`）、`getTransactionResult`、SSE `/events`。**indexer 返回 `access-control-allow-origin: *`，浏览器可直连**（已验证） |
| **Signer**：钱包守护进程 | `WalletDaemonSigner` | 用户本机跑 `tari_ootle_walletd`，浏览器能访问其 JSON-RPC | 只做两件事：`accounts.get_default` 拿默认账户，`transactions.sign` 签名（**0.48+ 才有**；0.47 walletd 报 `Method not found`，已验证） |
| **Signer**：本地密钥 | `SecretKeyWallet`（`ootle-secret-key-wallet`） | 无 | 私钥在 JS 内存，WASM 做 hash/签名/BOR 编码。官方标注"测试与脚本用，生产请用 walletd" |
| 多签名器 | `OotleWallet` | — | 按地址注册多个 key provider，`authorizeTransaction`/`signTransaction` |

授权流程（`ootle-wallet-daemon-signer/src/auth.ts`）：`auth.get_method` → `none` 时 `auth.request(permissions, "None")`；`webauthn` 时走浏览器 passkey（0.48 起首个 passkey 需要 walletd 启动时打印的 `setup_token`，且登记得到的 token 固定是 `Admin`）。

### 1.3 walletd 0.47 的授权模型（本机实测）

权限不是旧 tari.js 文档那套，而是**按资源 + CRUD** 的枚举（`auth.request` 报错信息列出的全集）：
`Admin, Accounts, Keys, Transactions, TransactionRequests, SigningRequests, Transfer, Templates, Nfts, Confidential, StealthUtxos, Validators, Settings, AddressBook, Substates, BurnProofs, SwapPools, Resources, Webrtc`。

- 形状：`{"Transactions":"Read"|"Create"|"Update"|"Delete"}`、`{"Substates":"Read"}`、`{"SigningRequests":"Create"}`；**可限定到账户**：`{"Accounts":["Read", "component_…"]}`（`null` = 全部）；`{"Transfer":["Create", …]}`。
- 拿到窄 token 后：`accounts.list` → `Insufficient permissions. Required 'Accounts(Read, None)'`；`transactions.submit_manifest` → `Required 'Transactions(Create)'`；`substates.get`、`transaction_requests.list` 正常。**最小权限可以做到"只能排队请求、不能花钱"**。
- 两条"dApp 请求 → 钱包主人批准"队列（这是 Ootle 的"provider 授权"机制，walletd 自带的 Web UI `http://127.0.0.1:12010/` 的 bundle 里有 `signing_requests.approve/reject` 与 `transaction_requests.approve/reject/submit` 的页面）：
  - `signing_requests.create {transaction:{V1}, seal_public_key, key_id}` → `{request_id, message_hash, expires_at}`；`approve` → 返回 `{public_key, signature:{public_nonce, signature}}`——**正是 ootle.ts `Signer.signTransaction` 要的形状**。dApp 自己 seal、自己提交。
  - `transaction_requests.create {transaction:{V1}, seal_signer}` → 批准后 **walletd 自己签+封+提交**（`get` 返回 `transaction_id`）。
  - 两者都不接受 `dry_run: true`（"a dry-run transaction cannot be committed, so it is never co-signed"）。
- WebRTC：`webrtc.start` 存在但默认关闭（`--enable-webrtc`），是远程 app 连钱包的通道（旧 WalletConnect 风格），本 spike 未测。
- **CORS**：0.47 swarm walletd 对带 `Origin` 的请求不返回任何 `access-control-*` 头（curl/undici 均验证），浏览器直连会被拦。walletd 有 `--enable-vite-dev-port <port>` 开关（"enable permissive CORS, set webauthn.rp_origin to http://localhost:{port}"，自述仅限开发）；spike 用 vite 代理 `/walletd` 绕过。

### 1.4 提交交易：指令级，不是 manifest

ootle.ts **只有指令级** `TransactionBuilder`（`callFunction`、`callMethod`、`createProof`、`saveVar`=`PutLastInstructionOutputOnWorkspace`、`feeTransactionPayFromComponent`、`dropAllProofsInWorkspace`、`authorizeProof`/`withAuthorizedProof`（0.12）、`withInputs`…）。manifest DSL 只存在于 walletd 的 `transactions.submit_manifest`，它要求 walletd 既解析又签名——也就是现在的托管路线。

因此 `clients/ts/src/budget.ts` 的 manifest 要翻译成指令序列。本 spike 的 [`web/spike/src/agentpay-tx.js`](../web/spike/src/agentpay-tx.js) 做了这件事，对应关系：

| `budget.ts` manifest | 指令 |
|---|---|
| `let funds = owner.withdraw(XTR, amount!(f))` | `CallMethod owner.withdraw(resourceAddressLiteral(XTR), amountLiteral(f))` + `saveVar("funds")` |
| `let (comp, ob, ab) = AgentBudget::new(funds, p, d, n, [m…])` | `CallFunction template "new" [Workspace funds, amountLiteral(p), amountLiteral(d), intLiteral(n), <手工 CBOR: 数组 of Tag(128,bytes32)>]` + `saveVar("ret")` |
| `owner.deposit(owner_badge)` / `owner.deposit(agent_badge)` | `CallMethod owner.deposit([Workspace "ret.1"])` / `"ret.2"`（元组下标 = `WorkspaceOffsetId.offset`） |
| `agent.create_proof_by_non_fungible_ids(badge, [non_fungible_id!("s")])` | `CallMethod agent.create_proof_by_non_fungible_ids(resourceAddressLiteral(badge), <手工 CBOR: 数组 of [1, ["s"]]>)` + `saveVar("proof")` |
| `budget.pay(proof, merchant, amount!(a), "memo")` | `CallMethod budget.pay([Workspace proof, componentAddressLiteral(m), amountLiteral(a), stringLiteral(memo)])` |
| `drop_all_proofs!()` | `DropAllProofsInWorkspace` |
| （walletd 自动加手续费） | `fee_instructions: [CallMethod payer.pay_fee(amountLiteral(maxFee))]` |

要点：
- 参数全部是 **CBOR 字面量**（`tari_bor` 编码），SDK 自带地址/金额/整数/字符串/NFT 地址的编码器，但**没有 `Vec<ComponentAddress>` 和 `Vec<NonFungibleId>`** 的——spike 手工编码（CBOR 数组头 + 元素；`NonFungibleId::String` 是 minicbor 枚举形 `[1, ["id"]]`）。
- **inputs 必须显式声明**（指令级提交没有 walletd 的 `detect_inputs`）：账户、它的全部金库、XTR 资源、模板、**白名单里的每个商户**（漏了 → `Template referenced root substate but it was not found: component_…`）、预算组件、预算金库、badge 资源。版本留 `null` 让执行时解析。
- **手续费由 `pay_fee` 指定的组件付**，本 spike 全部是用户自己的账户。没有"赞助费用"机制；理论上可用多签名器让后端账户付 `pay_fee`（0.48 的 `main_signer` 语义），未验证。
- **浏览器拿得到结果和事件**：indexer `GET /transactions/{id}/result` → `Finalized.execution_result.finalize.events`（topic `AgentBudget.pay`，payload 含 `merchant/amount/memo/session/spent_in_window`）；`Accept.up_substates` 里找新组件；SSE `/events` 可订阅。0.47 是 JSON；**0.48 起 indexer 返回 CBOR**，要用 ootle.ts 0.12 的 `decodeEvent`/`decodeSubstateValue`。
- 0.11.1 的坑（spike 已绕过）：`watchTransaction` 在提交后约 1 秒内 indexer 返回 404 会直接抛错（要当 pending 重试）；`final_decision=Commit` 但 `execution_result` 是 `AcceptFeeRejectRest`（只收了手续费、执行被拒）要自己识别为失败；交易 id 由内容决定，同 nonce 重发会撞 walletd 的 `UNIQUE constraint failed: transactions.transaction_id`。

## 2. 原型做了什么（证据）

目录 [`web/spike/`](../web/spike/README.md)（独立 vite 项目，依赖固定 0.47 包集，不碰 `web/server`、`web/public`、`clients/`）：

- `src/agentpay-tx.js`：上表的指令构造 + 回执/事件/组件状态解析。
- `src/walletd-signer.js`：**实现 ootle.ts `Signer` 接口的签名请求签名器**（`signing_requests.create` → 轮询 `get` 直到 `Signed` → 返回签名）。这是 0.47 上"用户钱包签、页面提交"的关键粘合件，0.48+ 直接换成官方 `WalletDaemonSigner`。
- `src/chain.js`：indexer 连接/金库发现/提交/等待（修 404 与 FeeIntentCommit）。
- `node/flow-a-browser-key.mjs`、`node/flow-b-walletd-approve.mjs`：两条路径的 Node 版；`index.html` + `src/main.js`：浏览器版（两栏）。

实测输出节选（本地 swarm，2026-11-02）：

```
[B] signing request #9 pending: 6 instructions, signer 28578f35a439… -> owner approves -> Signed
[B] open  tx 907414a7… COMMITTED -> budget component_296f4e1c…   ownerBadge resource_29425… agentBadge resource_2910d… caps 1000/1500
[B] pay   tx 2ad577ad… COMMITTED  event AgentBudget.pay {"amount":"700","merchant":"component_7ce2546e…","session":"default","spent_in_window":"700"}
[B] pay 5000 -> FeeIntentCommit: {"ExecutionFailure":{"code":"TemplateError","message":"At instruction #3: Template error: Amount exceeds the per-transaction cap"}}
[A] faucet tx d0633f67… -> account component_6e2b54b1…; open tx 6c3756b5…; pay tx 863c78d4… (同一事件); dry-run 5000 -> 同一拒绝原因
```

B 路径里 dApp 的 token 只有 `SigningRequests:Create/Read + Accounts:Read`；"钱包主人点批准"在原型里用另一条 Admin 会话调 `signing_requests.approve` 模拟（真实产品里是用户在 walletd 自带 Web UI 里点）。A 路径 walletd 完全不参与（账户由 localnet 内置水龙头 `component_010203…` 建）。

## 3. 方案对比

| 方案 | 对用户的要求 | 安全边界 | 现状 / 阻塞 |
|---|---|---|---|
| **B. 用户 walletd + 签名请求**（推荐，0.47 已验证） | 本机跑 `tari_ootle_walletd`；在它的 Web UI 里批准每笔请求；账户里有 XTR 付手续费 | 私钥在用户 walletd；dApp token 只能排队；每笔交易用户看见并批准 | 浏览器直连 walletd 需 CORS（`--enable-vite-dev-port` 或代理）；0.48 后签名接口变 `transactions.sign`（ootle.ts 0.12 `WalletDaemonSigner`），签名请求的返回形状可能跟着变 |
| **B'. 用户 walletd + `transactions.sign`**（0.48+） | 同上；WebAuthn 模式下首个 passkey 要 `setup_token` | 同上，但 **`transactions.sign` 无审批队列**——token 持有者可直接签（所以 token 作用域更关键） | 本机 0.47 无法验证；ootle.ts 源码注明 walletd 是否接受 `seal_public_key` "未对真实 daemon 验证"，失败只在提交时暴露为 `invalid signature` |
| **B''. `transaction_requests`**（walletd 自己提交） | 同 B | 同 B，页面连 seal/提交都不做 | 页面拿不到即时回执，要轮询 `get` 的 `transaction_id`；未跑完整流程 |
| **A. 浏览器密钥** | 无（点一下生成）；要有人给账户充值 | 私钥在 `localStorage`，XSS 即失守 | 只适合演示/小额；CSP 需允许 WASM |
| C. WebRTC（`webrtc.start`） | 用户 walletd 开 `--enable-webrtc` | 同 B | 未测；是远程/移动钱包的通道 |
| D. MetaMask snap / WalletConnect / Tari Universe（旧 tari.js） | 装 MetaMask Flask + snap… | — | **snap 包不在 npm，SDK 冻结在 0.14.6 且不兼容 0.47+**，不可用 |
| E. 维持托管（现状） | 无 | 服务器 walletd 持 owner badge + Admin token | 安全模型见 `docs/custody.md` |

## 4. 当前阻塞项（按影响排序）

1. **用户得自己跑 walletd**：没有扩展钱包，Ootle 今天的"用户钱包"就是 walletd 进程 + 它的 Web UI。这决定了非托管版面向的是开发者/高级用户，不是普通网页用户。
2. **CORS**：0.47 walletd 默认不发 CORS 头。产品上要么要求用户以 `--enable-vite-dev-port <我们页面端口>` 启动，要么我们的后端给用户 walletd 做反代（又回到后端能看见请求，但看不见私钥），要么等 WebRTC/上游改进。
3. **链版本耦合**：ootle.ts 0.11 ↔ 0.47，0.12 ↔ 0.49.1，交易互不兼容。esmeralda 现在是哪一版决定能不能在公网演示（另一会话 `docs/compat-0.49.md` 在核对）。
4. **指令级构造的两处手工 CBOR**（`Vec<ComponentAddress>`、`Vec<NonFungibleId>`）没有 SDK 保障，升级 `tari_bor` 时要用 ootle.ts 的 golden vector 测试复核。
5. **inputs 显式声明**：账户有多少金库就要列多少（`default` 有 21 个），依赖 `getVaultIdsForAccount` 走 indexer；账户金库很多时交易体变大。
6. **B 路径没有预演**：walletd 不给 dry-run 交易签名；要预演得由页面另建 `SecretKeyWallet` 签 dry-run——但账户 owner rule 是 `ByPublicKey`，别的 key 签会因权限失败，所以只能真提交。0.48 `transactions.sign` 是否接受 dry-run 未知。
7. **手续费**：每笔 owner 操作由用户账户付（本次 open ≈ 8 k µT、pay ≈ 2 k µT）。
8. **walletd 会被重启**：本机 swarm 会被其它会话 `start -k` 重启，签名请求队列持久化（id 连续），token 不持久。

## 5. 哪些现有代码能复用

| 现有 | 复用方式 |
|---|---|
| `clients/ts/src/budget.ts` 的 manifest 构造 | **不能直接用**（manifest 只有 walletd 能执行）。保留给后端/agent 侧（`pay`、MCP attach 模式）；owner 侧改用 `web/spike/src/agentpay-tx.js` 的指令构造。两者的注入防护思路不同：指令级参数是类型化 CBOR，memo 不可能"逃出字面量"，但地址正则校验仍要保留（错地址会被编码成无意义字节） |
| `web/server/substate.js`（按位解析组件状态） | **可直接用**。indexer 的 JSON 形状 `{"@cbor":"tag","tag":131,"value":{"@cbor":"bytes","hex":…}}` 与 walletd 的 `{tag, value:{hex}}` 对 `x.tag` / `x.value.hex` 访问器一致；spike 的 `parseBudgetSubstate` 就是同一套索引。0.48 起要先 `decodeSubstateValue` |
| `clients/ts/src/walletd.ts` 的 `finalizedOutcome`/`renderReject` | indexer 回执的 `execution_result.finalize.result` 与 walletd `get_result` 同形（`Accept`/`Reject`/`AcceptFeeRejectRest`），可直接套；注意 indexer 外层多一个 `Finalized.final_decision` |
| 事件解码（`OnChainBudget.payEvents`，topic `AgentBudget.pay`） | 同形，直接用于 indexer 回执和 SSE |
| `web/server/txlog.js`、`idempotency.js`、`reconcile` | 保留给后端自己提交的交易（agent pay）；用户前端提交的交易以 tx id 形式"登记"进 txlog 后由 reconcile 用 indexer 核实 |
| `web/server/authorizer.js`、`apikeys.js`、`audit.js` | 不变（它们约束的是 agent 侧 / API 侧） |
| `web/public/app.js` 的视图、i18n、账本、治理页 | 保留；只替换"owner 操作"的动作层（§7） |

## 6. 多用户模型

- **每个用户 = 自己钱包里的一个账户 + 自己的 owner badge**。`open` 由用户签名，badge 存回用户账户；后端永远拿不到 owner badge，所以 `set_limits / add_merchant / remove_merchant / revoke / revoke_session / issue_agent_badge / withdraw / top_up / configure_escrow` 全部走前端签名。
- **agent 侧仍可托管**（这正是 `docs/deployment-noncustodial.md` 的边界）：用户用 `issue_agent_badge(session, to_account=后端 agent 账户)` 把 session badge 发给后端（或发给 agent 自己的 walletd，MCP attach 模式），后端用它 `pay`。`API key → session badge` 的映射（commit c0b8083）不变。
- **后端如何发现用户的预算组件**（三选一，建议 1+3）：
  1. **前端登记**：开预算后把 tx id 交给 `POST /api/budgets`，后端用 indexer `GET /transactions/{id}/result` 核实 `Accept.up_substates` 里确有该模板的新组件，并读组件 `owner_rule: ByPublicKey` 与用户声明的公钥一致，才登记 `(用户公钥 → 组件地址)`。
  2. **链上扫描**：订阅 indexer SSE `/events`（0.47 localnet 只发 `TransactionFinalized`），对每笔交易读回执过滤 `template_address == AgentBudget`，自动建索引。更完整但吞吐大。
  3. **身份 = 公钥**：登录即"证明你持有这个账户的 key"。ootle.ts 没有 signMessage，最简单的证明是让用户签一笔 **dry-run 交易**（0 费用、不落链）作为挑战——A 路径可行，B 路径 walletd 不签 dry-run，要改用"签一笔真实零操作交易"或等 0.48 接口。
- **后端保留的职责**：只读索引/账本（从链事件 reconcile）、API key → session badge、审计日志、商户别名、发票、step-up（仅对 API/admin 操作；owner 操作的"二次确认"就是钱包里的批准）。

## 7. `web/` 逐文件改造计划

| 文件 | 改动 |
|---|---|
| **新增 `web/public/wallet/`** | 把 `web/spike/src/{agentpay-tx,chain,walletd-signer,walletd-rpc}.js` 和 ootle.ts 打成一个 ESM bundle（vite build，产物提交进仓库以保持"零构建运行"）；`index.html` 的 CSP 需加 `'wasm-unsafe-eval'`（WASM 必需）并允许 `connect-src` 到 indexer 与用户 walletd |
| `web/public/index.html` | 加"连接钱包"区（walletd URL、申请的权限、当前账户），加 CSP 项，引入 `wallet/` bundle |
| `web/public/app.js` | **保留**：`t()`/i18n、`sidebar/pageHead/viewOverview/viewPay/viewGovernance`、账本行渲染、`toast/confirmDialog`、`refreshState`。**改为前端直连**：`wireCreate`（open）、`wireGovernance` 里的 `setLimits/addMerchant/removeMerchant/revoke/revokeSession/withdraw/topUp/issueAgentBadge`——`handleAction` 对这些 action 不再 `api()` 到后端，而是构造指令 → `signer.signTransaction` → 提交 indexer → 把 tx id `POST /api/budgets/:component/txs` 登记。`stepUpToken` 对 owner 操作删除（钱包批准即二次确认）。**保留走后端**：`viewPay` 的 agent 付款演示（它本来就是 agent 侧）、API key 管理 |
| `web/server/server.js` | 删除 owner 操作的 `run*` 链路（`runOpen/runSetLimits/...` 中凡用 `OWNER` 账户签的）；`walletd()` 只保留 agent 账户用途；新增 `indexer.js`（REST 读：substate、tx result、epoch）替代 `substates.get`/`settings.get` 的链读；新增 `POST /api/budgets`（登记 + 核实）、`POST /api/budgets/:c/txs`（登记前端提交的 tx）；`reconcile` 改从 indexer 读；多用户：`state` 从"一个 component"改成 `map(ownerPubkey → component)`，所有 `/api/state` 带用户维度 |
| `web/server/substate.js` | 不变；0.48 时加一层 `decodeSubstateValue` |
| `web/server/txlog.js` | 加 `source: "frontend"` 条目类型（只有 tx id，由 reconcile 填结果） |
| `web/server/authorizer.js`、`apikeys.js`、`audit.js`、`stepup.js`、`idempotency.js` | 不变（step-up 仅保留在 API/admin 路径） |
| `web/DEPLOYMENT.md`、`docs/custody.md` | 补"非托管模式"段：用户 walletd 启动参数（`--enable-vite-dev-port`/代理）、权限申请清单、链版本对应 |

一步到位的最小切片：先只把 **open + set_limits + revoke** 三个 owner 操作改为前端签名并登记，其它 owner 操作仍托管；这样多用户模型（§6）就必须落地，而 agent 侧零改动。

## 8. 0.48 / 0.49 的影响（ootle.ts 0.12.0 升级说明 + 本机实测）

- **签名改标准 sr25519**：`TransactionSignature.signature` 从 `{public_nonce, signature}` 变成 64 字节 hex；`buildTransactionSignature` 签名改变。`web/spike/src/walletd-signer.js` 直接透传 walletd 返回的签名对象，形状变化会原样传下去，但 0.47 的 `signing_requests` 返回的是旧形状，**0.48 walletd 的签名请求返回形状需重新验证**。
- `is_seal_signer_authorized` → **`main_signer`**：0.12 的 builder 默认 `"None"`，`signTransaction` 自动改成第一个签名者 `{Authorizer: pk}`。0.47 walletd 的 `transactions.submit`/`signing_requests.create` 要求的是 `is_seal_signer_authorized`（本机实测报缺字段），所以 **0.11 与 0.12 的 unsigned tx 不能互用**。
- **walletd 新增 `transactions.sign`** → ootle.ts 官方 `WalletDaemonSigner` 可用，本 spike 的签名请求签名器变成"带审批队列的替代品"（如果 0.48 保留 `signing_requests`）。WebAuthn：`webauthn.auth_start` 不再要 `username`，首个 passkey 要 `setup_token`。
- **indexer 返回 CBOR**（0.48）：`substate.js`、事件解码、`findNewComponent` 之前都要先 `decodeSubstateValue/decodeExecuteResult/decodeEvent`（`ootle-wasm-bor`）。
- **AuthorizeProof 证明窗口**（0.49）：工作区里的证明不再自动授权后续调用；受 `rule!(resource(owner_badge))` 保护的 owner 方法（`set_limits` 等）要用 `withAuthorizedProof("proof", b => b.callMethod(...))` 包起来（0.12 builder 已有）。`pay` 把证明当**参数**传入并在模板内检查，不受影响。0.11 的 `createProof` + 直接调用在 0.49 会被拒绝。
- 上游未自动补的 input：资源的 auth-hook 组件要显式声明为 input（0.12 说明的"Not covered"），AgentBudget 的 badge 资源目前没有 auth hook，暂不涉及。

## 9. 建议

- **要不要走非托管**：取决于目标用户能否接受"自己跑 walletd"。如果是开发者/企业用户，走 B，并按 §7 的最小切片（open/set_limits/revoke）先落地；如果是普通网页用户，在 Ootle 出现扩展钱包或 WebRTC 移动钱包之前，托管 + `docs/deployment-noncustodial.md` 的 agent 侧分离是更诚实的产品形态。
- 任何实现都应等 esmeralda 的版本与本机 swarm 对齐（0.49 兼容会话的结论），然后把 spike 从 0.11.1 升到 0.12.x 重跑一遍再动 `web/`。

## 附：本次新增文件

`web/spike/{package.json, .gitignore, README.md, index.html, vite.config.js, src/agentpay-tx.js, src/chain.js, src/walletd-rpc.js, src/walletd-signer.js, src/main.js, node/flow-a-browser-key.mjs, node/flow-b-walletd-approve.mjs}`、`docs/wallet-integration.md`（本文）。`node_modules`、构建产物与 `.spike-key.json` 留在本地盘 `I:\build\wallet-spike`。
