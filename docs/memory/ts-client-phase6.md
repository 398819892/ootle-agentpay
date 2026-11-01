---
name: ts-client-phase6
description: "AgentPay 的 TypeScript/JS 客户端(镜像 Python onchain.py),本地 swarm 真实跑通"
metadata:
  node_type: memory
  type: project
  originSessionId: 17891825-1f58-4145-bc55-2447949e022e
  modified: 2026-10-26T02:28:44.253Z
---

为 AgentPay 补齐 **TypeScript/JS 客户端**,填"SDK 只有 Python"的门槛(评审一致指出)。位置 `clients/ts/`(自带 package.json/tsconfig,零运行时依赖)。

**它是什么:** 1:1 镜像 [[agentpay-phase3]] 的 `sdk/src/agentpay/onchain.py` —— 同样的 JSON-RPC 方法、manifest 字符串、事件解析。纯"薄 JSON-RPC + manifest 构造器",**不签名、不引密码学依赖**(walletd 用 manifest 里引用的账户签名+付费)。只用 Node 18+ 自带的全局 `fetch`。所有方法 `async`(Python 原版是同步)。
- `src/walletd.ts` = `WalletdClient`(connect/accountAddress/createAccount/fund/balance/dryRun/run,含只针对 esmeralda 瞬时 indexer 错误的重试)。
- `src/budget.ts` = `OnChainBudget`(open/pay/payInvoice/wouldReject/revoke/withdraw/addMerchant + `payEvents` 静态方法,从链上 pay 事件重建账本)。
- `src/invoice.ts`/`errors.ts` 镜像 memo 编码和异常层级。`src/demo.ts` 镜像 `examples/demo_devnet.py`。

**配置(构造参数或环境变量,默认本地 swarm):** `AGENTPAY_WALLETD_URL`(默认 `http://127.0.0.1:12010/json_rpc`)、`AGENTPAY_BUDGET_TEMPLATE`(默认 localnet `template_758d0c58…dec5b97`)、`AGENTPAY_OWNER_ACCOUNT`(默认 `default`)。指向 esmeralda 见 README(walletd 5100 + agent_budget `template_299d49bc…` + owner `dev`,见 [[esmeralda-deploy]])。

**实跑(本地 swarm,repo 产物 `node dist/demo.js`):** 开预算→付 700(链上 pay 事件)→超额/非白名单 dry-run 被链拒(理由原样来自验证节点:`Amount exceeds the per-transaction cap`/`Merchant is not whitelisted`/`Amount exceeds the daily cap`)→revoke(`Agent has been revoked`)→取回 8600→shop 到账 1400,余额对平。输出贴在 README。

**构建踩坑(重要):** [[tari-dev-needs-linux]] —— Windows 和 WSL 都没装 Node,用 `sudo apt-get install -y nodejs npm` 在 WSL 装了 Node 18.19.1(自带 fetch,满足 18+)。但在 **WSL 里对 Windows 挂载盘(`/mnt/f/...`)跑 `npm install` 会偶发损坏 node_modules**(tsc 报 `node_modules/typescript` 内部 `SyntaxError`,文件开头字节缺失)。解法:把 `src/`+配置 copy 到 WSL 原生目录(如 `~/agentpay-ts-build`)`npm install && npm run build`,再把 `dist/` copy 回 `clients/ts/dist/`。客户端零运行时依赖,所以 `dist/demo.js` 直接 `node` 跑、不需要 node_modules。
