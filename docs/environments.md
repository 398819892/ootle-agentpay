# 运行环境关系：本地 swarm · esmeralda · 仪表盘 · 两个钱包

> 回答一个反复出现的问题：仓库里同时出现的"本地 swarm"、"esmeralda walletd"、"`localhost:8787` 仪表盘"是什么关系，
> 为什么有**两个钱包**、两套模板地址、两套 state 文件。英文读者看 [`devnet.md`](devnet.md)（私链搭法）和
> [`esmeralda.md`](esmeralda.md)（公网部署记录）即可；本文只讲它们之间的**关系**。

## 1. 一张图

```
 浏览器 ──► 仪表盘  localhost:8787   （web/server/server.js，跑在 Windows / 任意有 Node 的地方）
                │  不碰链、不管密钥；把网页上的操作翻译成交易 manifest 发给"某一个" walletd，
                │  再把链上事件/状态读回来展示。一次只连一个钱包，由启动时的三个环境变量决定：
                │  AGENTPAY_WALLETD_URL · AGENTPAY_BUDGET_TEMPLATE · AGENTPAY_OWNER_ACCOUNT
                ▼
   ┌──────────────────────────────────┐      ┌──────────────────────────────────┐
   │ 本地 swarm（私链，localnet）       │      │ esmeralda（Tari 公共测试网）        │
   │ 整套都在 WSL ootle-dev 里：        │      │ 节点/验证节点/indexer 在 Tari 官方   │
   │ L1 基础节点+矿工、L2 验证节点、     │      │ 服务器上；本机只跑一个钱包进程，     │
   │ indexer、钱包 walletd              │      │ 通过公网 indexer 读写链             │
   │ 钱包 JSON-RPC 127.0.0.1:12010      │      │ 钱包 JSON-RPC 127.0.0.1:5100        │
   │ 账户 default / e2e_merchant        │      │ 账户 STBZ（水龙头充值，≈994 tTARI）  │
   │ 币：领的假币，随便花                │      │ 币：公网测试币，用一点少一点          │
   │ 模板 agent_budget 978113ef…        │      │ 模板 agent_budget 88b11261…         │
   │      escrow       bb8d36d2…        │      │      escrow       11dc03f7…         │
   │      otc_board    5c0cd27e…        │      │      otc_board    bafbe76e…         │
   └──────────────────────────────────┘      └──────────────────────────────────┘
```

## 2. 本地 swarm 是什么

一条完全在你电脑里的 Tari 链。`tari_swarm_daemon` 一次拉起整套进程：L1 的 `minotari_node` + 矿工（挖出 tTARI）、
L2 的 `tari_validator_node`（真正执行模板、达成共识）、`tari_indexer`（给钱包查状态）和一个 `tari_ootle_walletd`。

- **免费、快、可推倒重来**：`accounts.create_free_test_coins` 一秒领 1000 tTARI，交易几秒确认；`init --force` 整条链重来。
- **只有你能看到**：链上数据对外没有意义。重新 `init` 后**所有地址都会变**（账户、模板、预算组件），
  所以仓库里的 localnet 默认地址只对"当前这台机器、当前这次 init"有效，换机器要重新 `make publish-local` 并改默认值。
- 用途：开发、`make e2e` 三条真链回归、仪表盘日常演示。先在这里把流程跑通，再去 esmeralda。

搭法与命脉坑见 [`devnet.md`](devnet.md) 和 [`HANDOFF.md`](HANDOFF.md) §2.B。

## 3. esmeralda 是什么

Tari 官方的公共测试网，验证节点和 indexer 都在别人的服务器上，很多人共用。本机**不跑节点**，只跑一个
`tari_ootle_walletd --network esmeralda`（`:5100`），它通过公网 indexer（`ootle-indexer-b.tari.com`）提交交易、读状态。

- **公开可验证**：发到上面的模板和交易，任何人拿地址都能查到。README 里"已上链"指的是这条。
- **慢、会超时、币要靠水龙头**：公网 indexer 偶发 30 s 超时；SDK 对真实提交**不自动重发**（避免双花，见 `security.md` H5），
  遇到要先核对钱包里没有记录该 tx 再重跑。
- 用途：对外展示、发布正式版本的模板、把"真链确认付款 / `pay_via_escrow`"这类结论落到公网上。

部署与地址记录见 [`esmeralda.md`](esmeralda.md)。

## 4. 为什么是两个钱包

walletd 是**按网络绑定**的：一个钱包进程只能连一条链——密钥派生、账户列表、交易记录都和那条链的创世块绑在一起。
所以两条链各有一个 walletd 进程、各自的数据目录、各自的账户和密钥：

| | 本地 swarm 钱包 | esmeralda 钱包 |
|---|---|---|
| 进程 | swarm 自动拉起的 `tari_ootle_walletd`（经 keyring wrapper） | 单独启动的 `tari_ootle_walletd --network esmeralda` |
| 数据目录 | `/root/ootle/swarm/run/data/swarm/processes/wallet-daemon-00/` | `/root/.tari/ootle/` |
| JSON-RPC | `127.0.0.1:12010`，`auth=none` | `127.0.0.1:5100`，`auth=none` |
| 账户 | `default`（owner）、`e2e_merchant`（e2e 商户），假币 | `STBZ`（owner，水龙头充值）；旧机器的 `dev` 账户链上有币但**密钥不在这台机器** |
| 密钥来源 | 本次 `init` 新生成 | 2026-11-01 新生成 |
| 重启后 | `swarm start -k` 恢复，账户/模板都在 | 直接重起 walletd，账户/余额都在链上 |

两个钱包的密钥互不相干：`default` 在 esmeralda 上不存在，`STBZ` 在本地链上也不存在。
两边都用 `auth.request {permissions:["Admin"], credentials:"None"}` 免 WebAuthn 换 token，所以脚本里**不存任何凭据**。

## 5. 仪表盘和它们的关系

`web/server/server.js` 是一个零依赖的 Node 服务。它：

- **不碰链、不管密钥**——签名、提交都由它连着的那个 walletd 做；
- **一次只连一个钱包**，由 `AGENTPAY_WALLETD_URL` / `AGENTPAY_BUDGET_TEMPLATE` / `AGENTPAY_OWNER_ACCOUNT` 决定；
- **本地缓存按链隔离**：`AGENTPAY_STATE_FILE`（预算组件地址、商户别名、API key）和 `AGENTPAY_TXLOG_FILE`
  （交易日志）里记的地址只对它所属的那条链有效，换链必须换文件，否则启动对账会去另一条链上找一个不存在的组件。

| 目标 | walletd | 模板 | owner | state / txlog |
|---|---|---|---|---|
| 本地 swarm（默认） | `http://127.0.0.1:12010/json_rpc` | `template_978113ef…`（代码默认值） | `default` | `state.swarm.json` / `txlog.swarm.json`（都被 gitignore） |
| esmeralda | `http://127.0.0.1:5100/json_rpc` | `template_88b112610740f457bcc04be70740edebc53c132885a3dda928b1c068d98db8f6` | `STBZ` | `state.esmeralda.json` / `txlog.esmeralda.json` |

网页长得一模一样，区别只是：连本地 swarm 时操作秒确认、花假币；连 esmeralda 时每笔要等公网确认、花 `STBZ` 的测试币。

切到 esmeralda 的启动方式（Windows PowerShell 或任何 shell，改成对应语法即可）：

```bash
AGENTPAY_WALLETD_URL=http://127.0.0.1:5100/json_rpc \
AGENTPAY_BUDGET_TEMPLATE=template_88b112610740f457bcc04be70740edebc53c132885a3dda928b1c068d98db8f6 \
AGENTPAY_OWNER_ACCOUNT=STBZ \
AGENTPAY_STATE_FILE=$PWD/web/server/state.esmeralda.json \
AGENTPAY_TXLOG_FILE=$PWD/web/server/txlog.esmeralda.json \
PORT=8787 node web/server/server.js
```

SDK（`agentpay.onchain`）、TS 客户端、MCP server 和三条 e2e 脚本与仪表盘同理：都是"连一个 walletd + 一个模板地址"，
参数名对应 `WALLETD_URL` / `AGENT_TEMPLATE` / `ESCROW_TEMPLATE` / `OWNER`（见 `scripts/README.md`）。

## 6. 运行层面的依赖

- 三样东西里只有**仪表盘跑在 Windows**（或任何装了 Node 的机器）；swarm 和 esmeralda 钱包都在 WSL `ootle-dev` 里。
- **WSL 发行版一停，swarm 和 esmeralda 钱包一起没了**；仪表盘自己还活着，只是显示"钱包断开"，两者重起后它会自动重连。
  从 Windows 用 `wsl.exe` 拉起的后台进程会随发行版退出而死，所以要另开一个常驻会话（如 `sleep infinity`）把发行版撑住。
- 反过来，关掉仪表盘对两条链没有任何影响；关掉 swarm 对 esmeralda 没有影响，反之亦然（端口、数据目录、密钥全都分开）。
- 本机的具体脚本位置（`I:\wsl\setup\`：`swarm-init-start.sh [-k]`、`start-esme-walletd.sh`、`swarm-check.sh`、
  `publish-local.sh`、`publish-esme.sh`）见 `docs/memory/ootle-dev-wsl-on-i-drive.md`。

## 7. 一句话版本

**本地 swarm = 自己家的沙盒链（假币、秒确认、地址会变）；esmeralda = 公共测试网（真测试币、慢、地址对外有效）；
每条链各配一个 walletd（12010 / 5100），密钥互不相干；仪表盘只是前端，连哪个 walletd 就操作哪条链，state 文件跟着链走。**
