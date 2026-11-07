# web/spike — 用户自己的钱包在浏览器里签 AgentBudget 交易（原型）

> 结论与改造计划见 [`docs/wallet-integration.md`](../../docs/wallet-integration.md)。这里只说原型本身怎么跑、证明了什么。
> 它**不碰** `web/server`、`web/public`、`clients/`：是独立的 vite 小项目，依赖固定在 Ootle **0.47** 对应的 ootle.ts 0.11.1。

## 证明了什么（本地 swarm，2026-11-02）

两条"钱包侧签名"路径都真实完成了 **开预算 → 单枚 badge 证明付款 → 读到 `AgentBudget.pay` 事件 → 超限付款被链拒绝**：

| 路径 | 私钥在哪 | 签名怎么来 | 提交 | 本次链上记录（tx id 前缀） |
|---|---|---|---|---|
| **A** 浏览器密钥 | 浏览器 `localStorage`（`SecretKeyWallet`，WASM sr25519） | 页面自己签 | 页面直接 POST indexer `/transactions` | 浏览器：open `6c3756b5…` / pay `863c78d4…`；Node：open `c6f4ce84…` / pay `8cb721bc…` |
| **B** 用户的 walletd | walletd（`default` 账户，key index 1） | 页面发 `signing_requests.create`，钱包主人批准后 walletd 返回签名 | 页面用一次性 seal key 封装后 POST indexer | 浏览器：open `907414a7…` / pay `2ad577ad…`；Node：open `2ef036ba…` / pay `1cc9bd73…` |

两条路径里超限的 5 000 付款都被链以 `Amount exceeds the per-transaction cap` 拒绝（A 走 indexer dry-run，B 是真提交后 `FeeIntentCommit`）。
后端（`web/server`）全程不参与；walletd 在 A 里完全不参与。

## 文件

| 文件 | 作用 |
|---|---|
| `src/agentpay-tx.js` | **核心**：`open` / `pay` 的指令序列（对应 `clients/ts/src/budget.ts` 的 manifest，映射表写在文件头）、`Vec<ComponentAddress>` 与 `Vec<NonFungibleId>` 的手工 CBOR 编码、回执里找新组件 / 模板事件、按位解析预算组件状态 |
| `src/walletd-signer.js` | 实现 ootle.ts `Signer` 接口的 **walletd 签名请求签名器**（0.47 没有 `transactions.sign`，用 `signing_requests.create/get` 代替） |
| `src/walletd-rpc.js` | 带作用域权限的 walletd JSON-RPC 小客户端 |
| `src/chain.js` | indexer 读/提交/等待确认（修了 0.11.1 `watchTransaction` 提交后 1 秒内 404 直接抛错的问题；把 `FeeIntentCommit` 当失败） |
| `src/main.js` + `index.html` | 浏览器页面：A、B 两栏 |
| `node/flow-a-browser-key.mjs` | A 的 Node 版（水龙头建账户 → open → pay → dry-run 超限） |
| `node/flow-b-walletd-approve.mjs` | B 的 Node 版（dApp token 只有 `SigningRequests:Create/Read`；"钱包主人点批准"用另一条 Admin 会话模拟） |
| `vite.config.js` | WASM 插件 + `/walletd` 代理（0.47 walletd 不发 CORS 头） |

## 怎么跑

前置：本地 swarm 在跑（indexer `127.0.0.1:12008`、walletd `127.0.0.1:12010` auth=none，账户 `default`、`e2e_merchant`，模板 `template_978113ef…`），Node ≥ 22。

`node_modules` **不要装在网络盘上**（会损坏，见 `docs/memory/machine-y-drive-env.md`）：把本目录拷到本地盘（例如 `I:\build\wallet-spike`）再：

```bash
npm install
```

```bash
npm run flow:a
```

```bash
npm run flow:b
```

```bash
npm run dev
```

然后开 `http://localhost:5173`。A 栏：生成密钥 → 水龙头 → 开预算 → 付 700 → 试 5 000。B 栏：连接（只申请 `SigningRequests` + `Accounts:Read`）→ 开预算 → 页面提示"签名请求 #N 等待钱包主人"→ 点"模拟钱包的批准"（它用一条 Admin 会话调 `signing_requests.approve`，代替钱包 UI）→ 页面封装提交。

环境变量：`AGENT_TEMPLATE`、`MERCHANT`（B，账户名）、`MERCHANT_ADDRESS`（A）、`WALLETD_URL`、`WALLETD_ORIGIN`（vite 代理目标）。

## 已知限制

- 固定 0.47 包集（`overrides`）。链升到 0.48/0.49 后要换 ootle.ts **0.12.x**（签名改 64 字节 sr25519、`is_seal_signer_authorized` → `main_signer`、indexer 返回 CBOR 要 `decodeSubstateValue`），0.11 发出的交易 0.49 网络不收，反之亦然。
- 指令级提交要**显式声明 inputs**（账户、金库、XTR 资源、模板、白名单里的每个商户、预算组件及其金库、badge 资源），没有 walletd `detect_inputs` 那种自动发现。
- walletd 不给 dry-run 交易签名（"a dry-run transaction cannot be committed, so it is never co-signed"），B 路径没有预演，只能真提交看结果。
- A 的私钥明文放 `localStorage`，只是演示；要产品化得走 B（或 0.48 的 `WalletDaemonSigner` / WebAuthn）。

## 路径 C：window.tari（用户自带钱包，2026-11-06 新增）

A/B 都要求用户**自己跑 walletd**。路径 C 走 **`window.tari` 注入式 provider**——这是 Sapient 浏览器扩展和 Tari Universe 网页钱包共享的事实标准（"one interface, every Tari wallet"，连接脚本 `https://universe.tari.mw/tari-connector.js`）。钱包自己持钥、签名、提交到它自己的 indexer；dApp 只交出指令列表并轮询结果，**每笔交易在钱包弹窗里由用户批准**（这一批准就替代了我们后端对 owner 操作的 step-up）。这是"像连 MetaMask、用户不用自跑 walletd"的路线。

| 文件 | 作用 |
|---|---|
| `src/tari-window.js` | `window.tari` 适配器：`getTariProvider`（等 `tari#initialized`）、`TariWindowWallet.connect`（`tari_requestAccounts` + `tari_getNetwork`）、`createApproveSubmit`（create→轮询→submit 三段式）、`getSubstate`/`getTransactionResult`/`dryRun`、`describeTariError`（抹平 Sapient 字符串错误 vs Universe 数字错误码 4001/4100/4200）。**复用 `agentpay-tx.js` 的指令映射**，只换签名/提交层 |
| `src/window-tari-main.js` | 路径 C 页面逻辑：连接 → 开预算 → 付 700 → dry-run 超限。owner=连接的账户；**只交指令、不显式声明 inputs**（集成文档说 inputs "纯属优化"，钱包自动发现缺失 substate），钱包加手续费+epoch+签名+提交 |
| `window-tari.html` | 路径 C 页面（独立于 `index.html`） |

**先决条件（尚未做，`window-tari.html` 顶部有红条提醒）：** 本 spike 的指令构造仍钉在 **ootle.ts 0.11 / Ootle 0.47**，而线上测试网已是**重置后的 0.49.2**（只有 0.49.2 出了可用二进制，0.49.0/0.49.1 没构建成功），当前 ootle.ts 是 **0.13（对应 0.49.1）**。要在 esmeralda 上真连，得先：

1. 把 spike 依赖从 ootle.ts 0.11 升到 **0.13.x**——注意 **0.11.0 改了 `templateAddressLiteral` 的编码**（untagged bytes32），直接影响 `agentpay-tx.js` 里 `callFunction({templateAddress})` 的参数；再加 0.10.0（0.47）、0.12.0（0.49.1）两次 breaking。
2. indexer host 换成重置后的 **`esme-indexer-a.ootle.tari.com`**（ootle.ts README 里的 `ootle-indexer-a.tari.com` 可能已过时）。
3. Sapient 自身钉的是 **0.10.x / wasm 0.47 / wasm-bor 0.48.0-rc.0 + 一份 vendored patched wasm**（扩展版本 0.6.17），**是否已兼容 0.49.2 重置后的 esmeralda 未经确认**——这是能不能连通的最大未知项。源码里标 `VERIFY:` 的点（`tari_createTransactionRequest` 的 operation 形状、提交结果/substate 的 JSON 形状、Network 枚举值）都要用真钱包核一遍。

### 怎么跑（先决条件满足后）

1. 装 [Sapient](https://sapient.tari.mw/) 扩展（或在 Tari Universe 网页钱包里打开本页），在 Settings 里切到 esmeralda，账户先充过值（未充值账户 deposit 会 `OneOrMoreInputsNotFound`）。
2. `npm run dev`，开 `http://localhost:5173/window-tari.html`。
3. 填 AgentBudget 模板 + 白名单商户地址 → 连接钱包 → 开预算（弹窗批准）→ 付 700（弹窗批准）→ dry-run 超限（应被链上硬额度拒，无弹窗）。

集成文档（`universe.tari.mw/integration`）提醒的坑：钱包地址 `otl_…` ≠ 组件地址 `component_…`（指令参数要 `component_`）；别钉 substate 版本（用 `version:null`，`agentpay-tx.js` 已如此）；金额用字符串/bigint 不用 JS number（已如此）。

## 升级结果（2026-11-06，已验证）

依赖从 ootle.ts 0.11 升到 **0.13.0**（`package.json`，去掉 0.47 overrides）。装好后 `@tari-project/ootle-wasm` 解析为 **0.49.2**——正好是线上 esmeralda 重置后的协议版本，所以读/构造与线上同版。

无钱包、无充值的 smoke（`node/smoke-esmeralda.mjs`，`npm run smoke:esme`）通过：

- **连上 `https://esme-indexer-a.ootle.tari.com`，读到 `currentEpoch=12909`**——indexer 主机正确、读操作与 0.49.2 网络兼容。
- **用 0.13 构建 open（6 指令 / 4 inputs）、pay（4 指令 / 6 inputs）全部通过，`agentpay-tx.js` 一行没改**——builder 内部已处理 0.11.0 的 `templateAddressLiteral` 编码变化（untagged bytes32），`amountLiteral`/`resourceAddressLiteral`/手工 CBOR 等字面量编码器都还在。`open[0]` 序列化为正常的 `CallMethod withdraw`。

**仍待验证（需充值过的 esmeralda 账户，或你自己的钱包）：** 真正的 open+pay 落链。两条提交路径各差一步：

- **flow-A/B（Node，`chain.js` 的 seal/submit）尚未在 0.49 上跑过**——0.48+ 起 indexer 回执返回 CBOR,`waitFinalized`/`findNewComponent` 的解析可能要加 `decodeSubstateValue`/`decodeExecuteResult`，签名也从 0.47 的形状改了；要真提交得先把 `chain.js` 这层也迁到 0.49，并给 flow-A 一个充值过的 esmeralda 账户（SDK 的 localnet 水龙头在 esmeralda 不一定可领，一般走网页水龙头）。
- **window.tari（路径 C）不走 `chain.js`**——钱包自己 seal/submit，所以不受上面那层影响；只差你装 Sapient 扩展（或用 Tari Universe 网页钱包）、账户充值后在 `window-tari.html` 上点连接。源码里 `VERIFY:` 的点要在真钱包上核。

## chain.js 迁 0.49（2026-11-07）

把 `src/chain.js` 从 0.11 迁到 **0.13 的交易生命周期**：`resolveTransaction` → `signTransaction` → `sealTransaction` → `submitTransaction` → `watchTransaction` → `classifyOutcome`（非 `Commit` 抛错），dry-run 走 `sendDryRun`，并加了 `decodeExecResult`/`decodeSubstate`（`ootle-wasm-bor` 的 CBOR 解码，标 `VERIFY:`）。**加 `--experimental-wasm-modules` 后整文件干净加载，所有导出都解析得到。**

**客户端签名（flow-A）在 0.49 上的确切门槛已定位——不是 `chain.js` 的缺陷，是“必须有充值账户”这同一道闸：**

- 逐步二分（`node/probe6.mjs`）：**空交易能签**；只要带一条 `CallMethod`（哪怕只是手续费的 `pay_fee`）就报 `JSON deserialization failed: data did not match any variant of untagged enum TransactionInput`。
- 根因：0.49.2 的 WASM 签名器（`addTransactionSigner`）要求 `CallMethod` 的组件目标先被解析成**输入引用**，而不是 builder 默认发出的 `{"Address": <账户地址>}` 字面量。`resolveTransaction` 正是干这个的——它拿声明的 input substate **去 indexer 查**，把地址改写成输入引用（`probe7.mjs` 证实：resolve 会真的打 indexer，失败信息是 `Failed to resolve input … Invalid substate id`，因为我用的是没上链的临时账户）。
- 所以 flow-A 的 `sign` 这步**离不开一个真实、已充值、在链上的 esmeralda 账户**（真正的 `component_…` substate，indexer 能查到）。`chain.js` 本身是对的：`openBudgetTx` 已把 owner+vaults 用 `withInputs` 声明为输入，`signSealSubmit` 也先 `resolveTransaction`。只是本机 smoke/probe 用的是假地址，resolve 无从解析。
- **window.tari（路径 C）不受影响**：外部钱包用自己充值过的账户，自行 resolve+sign+submit。

一句话：`chain.js` 迁移已结构完成且能加载；flow-A 的落链验证仍卡在“需要充值账户”，与升级前同一道闸。

环境：Node 22 + 依赖装在 WSL ext4（`~/agentpay-spike`），不在网络盘上。
