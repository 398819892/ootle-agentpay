# web/spike/pathb — L1 XTM 免确认代付（路 B 原型）

让 AI agent 用 **L1 XTM**（你挖的原生 Tari，不是 L2 Ootle 资源）在**额度内免确认付款**。额度不是靠链上合约卡（L1 没有合约），而是靠一个你自己的**预算网关**在软件层卡，背后接一个**无界面的 minotari 钱包**真签真发单向支付。

## 为什么是这个形状

- 链上硬额度 = 智能合约 = 只能在 L2。L1（XTM）没有合约，没法在原生 XTM 上挂程序化额度。
- 所以「owner 设额度、agent 额度内免确认」在 L1 只能**软件执法**：
  - **钥匙**在一个无界面的 `minotari_console_wallet` 本地（`--password` 加密）= 非托管；
  - **额度**在预算网关里（单笔上限 / 每日上限 / 白名单 / 总额）；
  - **agent** 只跟网关说话，永远拿不到钥匙、够不到钱包 gRPC。它天然超不了额度。

```
agent ──POST /pay {merchant, amount}──▶ 预算网关 ──gRPC Transfer(one-sided)──▶ minotari_console_wallet
                                          │                                       └─ 直接签名+广播, 无确认
                                          └─ 白名单? 单笔≤? 当日≤? 总额≤?  —— 额度内才放行, 超了直接拒(不碰钱包)
```

两道防线：**专用钱包只充预算那点钱**（硬天花板，就算网关被绕过，最多也只有这点钱能动）＋ **网关的细额度**（单笔/每日/白名单）。

## 文件

- `wallet.proto` — minotari 钱包 gRPC 的最小切片（`Transfer` / `GetBalance` / `GetCompleteAddress` / `GetTransactionInfo`，`package tari.rpc`）。字段名对齐官方，**字段号是原型本地的**；接真钱包时换成官方 `wallet.proto`。
- `src/gateway.mjs` — `BudgetGateway`：额度执法 + 调 `Transfer`。额度检查任一不过 **就直接返回、不碰钱包**。
- `src/gateway-server.mjs` — agent 接口：`POST /pay`、`GET /status`（本地 HTTP，只给 agent 用）。
- `node/mock-wallet-grpc.mjs` — 替身 gRPC 钱包：记录收到的每一笔 Transfer，供离线断言「超额度的从没到过钱包」。
- `node/pathb-flow.mjs` — 闭环 harness。
- `src/quota.example.json` — 额度配置样例（µT）。

## 离线跑通（无需真钱包/真币）

```bash
cd web/spike/pathb && npm install && npm run flow
```

验证：额度内直接发（无确认）、超单笔/超每日/超总额/非白名单全部拦截且**从没到过钱包**、每日滚动窗口按时重置、同样的拦截通过 HTTP agent 接口也成立。

## 接真钱包（在链上真发 XTM —— 这步你自己来）

1. 跑一个无界面 minotari 钱包（**专用钱包，只充预算**；**先用测试网/小额**，别拿主网真币试）：
   ```bash
   MINOTARI_WALLET_PASSWORD=yourpass minotari_console_wallet --non-interactive --grpc-address 127.0.0.1:18143
   ```
2. 把官方 `wallet.proto`（tari-project/tari `applications/minotari_app_grpc/proto/wallet.proto`）替换本目录的原型 proto。
3. 填 `src/quota.example.json`（或自己的 QUOTA_JSON）：白名单填真商户地址，额度按需。
4. 起网关指向它：
   ```bash
   WALLET_GRPC=127.0.0.1:18143 QUOTA_JSON=./src/quota.example.json npm run gateway
   ```
5. agent 调 `POST http://127.0.0.1:8799/pay {"merchant":"<地址>","amount":"<µT>"}`。额度内即时成交、不弹窗；超了拿到 402。

## 要诚实记住的坎

- **额度是软件级，不是链级**：可信度 = 网关 + 专用钱包天花板。你掌控这台机器时够用；对手能直连钱包 gRPC 就能绕过——所以**务必保证只有网关能到那个 gRPC 端口**（本地隔离/防火墙；官方 gRPC 鉴权配置待确认）。
- **L1 发款只有 Rust 的 console wallet / FFI，没有 JS SDK**：所以 L2 那套 `agentpay-tx.js` 的 open/pay builder 在这里用不上，结算走 gRPC `Transfer`。
- **真发币我不替你执行**：动真 XTM 是你自己点的那一步。
