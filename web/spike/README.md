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
