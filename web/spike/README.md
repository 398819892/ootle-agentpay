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
| `src/tari-window.js` | `window.tari` 适配器：`getTariProvider`（等 `tari#initialized`）、`TariWindowWallet.connect`、`signAndSubmit`（**原始指令的提交通道** = `tari_signAndSubmitTransaction`）、`dryRun`、`createApproveSubmit`（3 段式，**仅用于钱包高层操作 shield/sendPrivately/htlc\***，不是我们的原始指令）、`getSubstate`/`getTransactionResult`、`describeTariError`、`normaliseNetwork`（名字 or 数字字节都接）。**复用 `agentpay-tx.js` 的指令映射**，只换签名/提交层 |
| `src/window-tari-main.js` | 路径 C 页面逻辑：连接 → 开预算 → 付 700 → dry-run 超限。owner=连接的账户；**只交指令、不显式声明 inputs**（集成文档说 inputs "纯属优化"，钱包自动发现缺失 substate），钱包加手续费+epoch+签名+提交 |
| `window-tari.html` | 路径 C 页面（独立于 `index.html`） |

**先决条件（进度）：**

1. ~~升依赖到 0.13.x~~ **已做**（见「升级结果」；`@tari-project/ootle-wasm` 解析为 0.49.2 = 线上版本，`agentpay-tx.js` 一行没改）。
2. ~~indexer host 换 `esme-indexer-a.ootle.tari.com`~~ **已做**（smoke 连通，读到 epoch）。
3. **唯一剩下的硬门槛：拿真钱包 + 充值账户在 esmeralda 上跑一遍**（装 Sapient 或用 Tari Universe 网页钱包）。Sapient 非官方、单人维护、只覆盖 esmeralda/igor；是否已兼容 0.49.2 重置后的 esmeralda 仍未在真钱包上确认。

### 适配器核实（2026-11-07）

照着 live 的 `https://universe.tari.mw/tari-connector.js`（未压缩、可读，声明与 Sapient 注入 provider 同形）把适配器核了一遍，改掉了几处：

- **CONFIRMED（源码里有）**：`window.tari.request({method,params})` 约定、全部 `tari_*` 方法名、单笔 `tari_signAndSubmitTransaction` 与 3 段式 `createTransactionRequest→getTransactionRequest→submitTransactionRequest` **两条提交路都存在**、`createTransactionRequest` 返回 `{requestId}`、状态集 `approved/submitted/rejected/failed`（结果在 `summary.result`、错误在 `summary.error`）、错误对象带 `{code,message}`。Network 枚举值也用本机 SDK 核实：**Esmeralda=38(0x26)、Igor=36(0x24)**。
- **改对的**：① 原始 AgentBudget 指令走 **`tari_signAndSubmitTransaction`**，不是 3 段式——后者的 `kind` 全是高层私密操作（shield/unshield/sendPrivately/htlc\*），源码里**没有 `kind:"instructions"`**；② `tari_getSubstate` 返回路径是 **`resp.substate.Component.body.state`**，不是 `state.up.substate.*`（那是交易回执 diff 形状）——`parseBudgetSubstate` 现同时接两种；③ `tari_getNetwork` 可能回名字也可能回数字字节，`normaliseNetwork` 都接。
- **仍只能在真钱包上核的 `VERIFY:`**：`tari_signAndSubmitTransaction` 的确切入参/返回形状、`dryRun:true` 是否真无弹窗、错误码具体数字（4001 等是 EIP-1193 习惯值，连接器没定义）、`getSubstate` 返回是 JSON 还是 CBOR-base64、`.Component.body.state` 这条尾路径。连接器是个薄 postMessage 转发层，这些都由钱包端决定，源码核不到。

> 结论：从源码能核的都核了、改对了；剩下一批形状**只有真钱包能定**，正是阶段 1（真网 open+pay）要一次性验掉的东西。

### 换 Tari Universe 作为 window.tari 钱包（2026-11-07）

决定：轴 B 押路径 C，但**钱包用官方的 Tari Universe，不用 Sapient**。照官方集成文档（`universe.tari.mw/integration` 的 SKILL.md）核实：

- **通用签名可用（好消息）**：Universe 暴露完整 `window.tari`，原始指令两条路文档里都有——`tari_signAndSubmitTransaction {instructions, maxFee?, inputs?, dryRun?}`（"prompts unless dryRun"）和 `tari_createTransactionRequest {kind:"instructions", instructions, …}`。之前担心的「桌面 tapplet 只放行 4 个方法、不能通用签名」在现行文档里**不存在**。唯一禁的是手搓 `StealthTransfer`（我们不发）。`dryRun:true` 无弹窗、`tari_getNetwork` 回名字字符串、错误码 4200 都已确认，适配器对得上。
- **连接模型和 Sapient 不同（关键 catch）**：Universe 是 `universe.tari.mw` 上的**托管网页钱包**，它把 dApp 放进一个**跨域 iframe** 里跑，connector 通过 postMessage 和父窗口钱包通话。**独立的 localhost 标签页拿不到 `window.tari`**（只有装了 Sapient 扩展才有）——所以本页必须**在 universe.tari.mw 内部被加载**才行，dev server 还得发 `Content-Security-Policy: frame-ancestors 'self' https://universe.tari.mw;`。**怎么让 Universe 去加载一个 localhost dev 页，文档没说、未确认**——这是新的未知项。
- **充值仍然卡住**：Universe 文档里**没有 faucet**，和 Sapient 一样卡在 reset 后没测试币（见下「esmeralda 0.49.2 reset」）。
- 改动：`window-tari.html` 顶部的过时警告已换成当前三道 blocker（没币 / 模板要在 0.49.2 重发 / iframe 加载）；Sapient 字样退成次要。适配器 `createApproveSubmit` 注释修正为「`kind:"instructions"` 也合法，等价于 signAndSubmit」。

### 包成 Tari Universe tapplet（2026-11-07）—— 上面的「iframe 加载」未知项已解

「怎么让 Universe 去加载我们的页面」查清了：Universe 里嵌入的 dApp 叫 **tapplet**，有官方入口，**不是**私下求钱包团队。机制从 `tari-project/tari-universe` 源码核实（分支 `main`）：

- **开发入口（现在就能用，不要币、不要审核）**：Universe 的 **Tapplet Registry** 页有 **Add dev tapplet**，只填一个 endpoint URL。后端 `add_dev_tapplet`（`src-tauri/src/commands.rs`）会 `GET <endpoint>/tapplet.manifest.json`，按 `DevTappletResponse` 解析，**只要两个 camelCase 字段**：`{ "packageName": "...", "displayName": "..." }`。URL 是字符串拼接（endpoint 末尾**别带斜杠**，否则变 `//tapplet.manifest.json`）。然后它把 `<endpoint>` 本身塞进 iframe。
- **权限文件**：安装/发布路径读 `dist/tapplet.config.json` → `TappletConfig { packageName, version, supportedChain, permissions:{requiredPermissions,optionalPermissions} }`；权限枚举是 `TariPermissionAccountList / TransactionSend / SubstatesRead / TemplatesRead / AccountInfo / AccountBalance / TransactionGet …`。缺这个文件权限默认空数组（带告警）。
- **CSP 仍然必须**：tapplet 在跨域 iframe 里跑，页面要发响应头 `Content-Security-Policy: frame-ancestors …`（`<meta>` 对 frame-ancestors 无效，必须是响应头）。Universe v1.6.18 刚补了「没校验 postMessage 发信方 origin」的漏洞（GHSA-mj75-4pfh-7q38），所以这套握手现在是硬要求。

本 spike 的 tapplet 打包（**已离线验**）：

- `tapplet/index.html` —— 独立的 AgentPay tapplet 页（复用 `src/window-tari-main.js`，脚本用绝对路径 `/src/…`，在 /tapplet/ 下也能解析）；不动原来的 A/B/C 合并 demo（`index.html`）。
- `public/tapplet/tapplet.manifest.json` —— `{packageName, displayName}`，给 Add dev tapplet。
- `public/tapplet/tapplet.config.json` —— `TappletConfig`，权限清单。
- `vite.config.js` —— 两处：① `server.headers`/`preview.headers` 发 `frame-ancestors 'self' https://universe.tari.mw http://localhost:5173 http://127.0.0.1:5173`；② `build.rollupOptions.input` 加 tapplet 入口，`vite build` 会出 `dist/tapplet/index.html`。

**加成 dev tapplet：** `npm run dev`，在 Universe 的 Tapplet Registry → Add dev tapplet 填 **`http://localhost:5173/tapplet`**（无尾斜杠）。Universe 会 `GET /tapplet/tapplet.manifest.json`（→ AgentPay），再 iframe `/tapplet/`。dev server 已核实：manifest/config/页面三者都 200 且都带 `frame-ancestors` 响应头（WSL headless curl 验过）。

还没落地的两点：① 线上 `universe.tari.mw` 用的 host 版 Universe 能否被指向 localhost dev endpoint（Add dev tapplet 是桌面版功能，host 版可能只认已注册的 registry tapplet）——要在真 Universe 里点一下才知道；② **发布路径**（给别人用）= 按 RFC 把 tapplet 发成 npm 包、进 `tapplets-registry.manifest.json`（registry：`karczuRF/tapp-registry`），且安装包要求 `package/dist/tapplet.config.json` 在 dist 根（本 spike 现放在 `/tapplet/` 子目录下，发布时要调）。build 还有个环境坑：WSL 那份 `vite-plugin-top-level-await` + swc 组合 `vite build` 报 `missing field type`（和本改动无关，dev 路径不受影响）。

### esmeralda 0.49.2 reset 把链上旧状态清了（2026-11-07 实测）

查了所有 indexer（`esme-indexer-a/b`、`ootle-indexer-a/b`，全同一个网、epoch 12920）：2026-11-01 部署的 agent_budget 模板、escrow 模板、充值账户、Caravel 水龙头组件**全部 404**。所以阶段 1 之前要先解决两件事，且都压在「怎么在 reset 后的 esmeralda 上搞到第一笔测试币」上：**① 给账户充值**（Caravel 死了、walletd faucet 空，唯一文档化的路是 L1-burn→claim）；**② 把 agent_budget 在 0.49.2 重发**（旧地址已失效，流程见 `docs/esmeralda.md` + `scripts/esme-fund`、`scripts/esme_publish_retry.sh`）。

### 怎么跑（先决条件满足后）

1. 在 **Tari Universe 网页钱包**（`universe.tari.mw`）里打开本页（本页必须跑在 Universe 的 iframe 内才拿得到 `window.tari`；dev server 要发 `frame-ancestors` CSP，见上）。账户先充过值（未充值账户 deposit 会 `OneOrMoreInputsNotFound`）。
2. `npm run dev`，让本页可被 Universe 加载（纯 localhost 直开拿不到钱包）。
3. 填 **0.49.2 上重发的** AgentBudget 模板 + 白名单商户地址 → 连接钱包 → 开预算（弹窗批准）→ 付 700（弹窗批准）→ dry-run 超限（应被链上硬额度拒，无弹窗）。

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

## 桥接回归测试（2026-11-09）

live 钱包（`node/wallet-server.mjs`，:7777）↔ dApp（仪表盘 :8787）之间的 **WalletConnect 式中继**（dApp 只能 `POST /bridge/req` 入队、轮询 `/bridge/res`；钱包同源 `/bridge/poll` 取件、批准签名后 `/bridge/resolve` 回填；`linkedOrigin` 持久化 + CORS 只对 dApp origin 开 `/bridge/*`）从 `wallet-server.mjs` 抽成了独立模块 **`src/dapp-bridge.mjs`**（零链 / 零引擎 / 零密钥依赖，`wallet-server.mjs` 委托它，行为逐字不变）。

测试 **`node/dapp-bridge.test.mjs`**（`node --test`，零依赖，13 用例全绿）：
- **状态机**（无 HTTP）：id 自增、poll 只取未认领且认领后不再出、resolve 后出队不重复投递、`linkedOrigin` 只由被批准的 `tari_requestAccounts` 置位（pay / 被拒的 connect 都不置）、`unlink` 清除、`corsHeadersFor` 只放行白名单 origin、`dappOrigins` 接受逗号串或数组。
- **端到端 HTTP**：真起 http server 挂 `bridge.handle`，用**真实的 `tari-provider.js`**（`window.tari`，在 mock DOM 下加载）驱动,fetch 循环扮钱包：connect 回传账户、committed 付款原样透传、超单笔上限作为 `committed:false` 结果（而非异常）透传、钱包 error 让 dApp 的 Promise reject、CORS 预检只给白名单 origin 发头。

跑：`npm test`（= `node --test node/*.test.mjs`）。**WSL 看不到网络盘 `W:`**，所以把 `src/` + `node/` + `tari-provider.js` 拷到 WSL 能读的本地盘（如 `/mnt/c/…` 或 ext4）再跑；这套纯 JS 测试不需要 `npm install`（只用 node 内置 `node:test`/`node:http` + 全局 `fetch`，Node ≥18）。
