# Ootle AgentPay — 项目交接 (HANDOFF)

> 目的：换一台电脑、开一个新会话，也能独立把这个项目接着往下做。
> 写于 2026-11-01，对应 `master @ eac1c6c`；2026-11-01 晚在新机器（`Y:\公用1\oolte`）续写，见 §6。看完这份 + `README.md` + `docs/` 就够上手。

---

## 0. 一句话 + 现状

**Ootle AgentPay** = 给 AI 代理用的「链上硬限额钱包」。核心是 Tari Ootle L2 上的 Rust→WASM 模板
（`AgentBudget` 预算 + `Escrow` 托管；`OtcBoard` 场外托管**已冻结**），外面包了 Python SDK、
零依赖 TS 客户端、MCP server、以及一个零依赖的 Web 托管仪表盘和 `/api/v1` M2M REST。
**链是唯一权威**：每一笔付款的每笔/每日限额、白名单、撤销都在链上校验，钱包只是提交 + 读链 + 记账。

- 分支：`master`，远端 `github.com/398819892/ootle-agentpay`，**已全部推送**。
- CI：`.github/workflows/ci.yml`，6 个 job（templates ×3 / sdk / web / ts），最近一次 **全绿**。
- 工作树干净，只有 4 个未跟踪的中文评审 `.md`（评审往来，不入库，可删）。

---

## 1. 架构与目录

```
templates/            三个 Rust→WASM 模板（tari_template_lib），cargo test 在 Linux 跑
  agent_budget/       AgentBudget：预算 + 每笔/每日限额 + 白名单 + 多会话 badge + pay
  escrow/             Escrow：买家出资托管、释放/退款
  otc_board/          OtcBoard：P2P 场外托管 —— 已冻结（代码在，顶部有 FROZEN 横幅，不再演进）
sdk/                  Python SDK `ootle-agentpay`（onchain.py=链客户端, invoice.py=memo/发票, ...）
clients/ts/           零运行时依赖的 TS 客户端（镜像 onchain.py）；dist/ 已入库，服务器直接加载
integrations/agentpay_mcp/  真 MCP server，把 AgentPay 包成 Claude Desktop/Cursor 的工具
web/                  仪表盘：零依赖 Node 后端 server/server.js + 手写 SPA public/app.js（无构建）
                      + /api/v1 M2M REST + docker-compose.yml/DEPLOYMENT.md（非托管部署拓扑）
scripts/              ci-local.sh、fetch-binaries.sh、各 publish-*.sh、demo、e2e、stability/
node-binaries/        预编译 Tari 二进制（.gitignore，用 scripts/fetch-binaries.sh 重新下）
docs/                 devnet / esmeralda / security / custody / api / stability / audit-notes ...
Makefile              一条命令跑全套：make ci / swarm-up / dashboard / demo / publish-local
```

**不在 git 里、新机器是空的（见 §3）**：`web/server/state*.json`、`web/server/txlog.json`（运行态账本）、
`node-binaries/`、`node_modules/`、`.venv/`、以及整个 WSL 私链环境和 `~/.claude` 内存笔记。

---

## 2. 新机器从零跑起来

### 先决条件：必须有 Linux / WSL（原生 Windows 跑不了模板测试和 CLI）
`wasmer` 写死 Cranelift，而 `wasmer-compiler-cranelift` 在 Windows 直接 `compile_error!`；`tari-ootle-cli`
依赖 `openssl-sys` + `wasm-opt-sys`（binaryen）在 MSVC 编译失败。所以：**本机装 WSL2 + Ubuntu，所有
Rust/Python/链相关命令都在 WSL 里跑**。Windows 侧只能做 clippy/wasm 构建。详见内存 `tari-dev-needs-linux`。

WSL 里要装：Rust（带 `wasm32-unknown-unknown` target）、`build-essential cmake clang libssl-dev`、
Python ≥3.11、Node ≥18、以及 `tari-ootle-cli`（`cargo install`，crates.io 实际是 0.33.x）。

### A. 克隆 + 跑测试（不需要链，最快确认环境 OK）
```bash
git clone https://github.com/398819892/ootle-agentpay.git
cd ootle-agentpay
make ci          # 一条命令跑全套（templates + sdk + web + ts）并给 pass/fail 汇总
```
各子套件单独跑（Makefile 里都有）：
- 模板：`make test-templates`（**注意**：CI 会先 `cargo update -p tari_crypto --precise 0.24.0`，锁已入库）
- SDK：`make test-sdk`（= `pytest -q --ignore=tests/test_keys.py`；test_keys 要 ootle-py，可选）
- Web：`make test-web`（零依赖，node 跑 server/*.test.js，不碰真链）
- TS：`make test-ts` + `cd clients/ts && npm test`（tsc 构建 + node --test 注入/事件套件）

> **不确定环境时，先信 GitHub CI**：推上去看 6 个 job 是否绿，比本地折腾快。

### B. 本地私链 devnet（要真链上演示/发布时）
预编译二进制跑本地 Tari swarm，**无需源码编译**。完整配方见 `docs/devnet.md` 和内存 `local-swarm-devnet`。
```bash
bash scripts/fetch-binaries.sh    # 重新下预编译二进制到 node-binaries/（gitignore）
make swarm-up                     # 起本地 swarm（挖矿产币、自动注册 VN；walletd 在 127.0.0.1:12010）
make publish-local                # 发布 escrow + agent_budget + otc_board 到本地 swarm
make swarm-down                   # 停
```
**这台机器（I 盘 `ootle-dev` WSL）的本地 swarm 已于 2026-11-02 init 并跑通**：`default` 账户已领币，三模板已发布 ——
agent_budget `template_978113ef1251cf83cff05ca21057eefcaa2ebaa7770abf07ba82d6ffda0e453f`、
escrow `template_bb8d36d251730c7e6d5a725bddf51ce43acf99ca62e7e4977e635ea3305ee3c0`、
otc_board `template_5c0cd27ed0ee5867f4b960a12e33baec848c970c8b3145faf063ae3c7b8f8f28`（仓库里的 localnet 默认地址已改成这三个）。
重启后用 `I:\wsl\setup\swarm-init-start.sh -k` 恢复；从 Windows 驱动时要另开一个 `sleep infinity` 的 wsl 会话保活，
否则发行版退出会把 swarm 一起带走。三条真链 e2e（`make e2e`）在它上面全部通过。
**本地私链的命脉坑（都已解决，换机器重搭会再遇到）**：
- **L1/L2 版本必须匹配**：L2 tari-ootle v0.47.0 pin 的 L1 是 minotari **6.2.0-pre.2**（不是 README 的 5.2.0-pre.5），
  且 L1 要 **esme 版**不是 mainnet 版，否则 VN 注册签名失败 / 拒绝 localnet。
- **walletd keyring**：WSL 无 OS keyring，walletd 要 `--override-keyring-password`，但 swarm 不给子进程传 →
  用 wrapper 脚本自动追加（原二进制存成 `tari_ootle_walletd.real`）。
- **JSON-RPC 要 bearer token**：即使 `--wallet-daemon-auth none`，也要先 `POST auth.request`
  `{"permissions":["Admin"],"duration":null,"credentials":"None"}` 换 Admin JWT。
- **领币**：localnet 用 `accounts.create` + `accounts.create_free_test_coins`（esmeralda 公共 faucet 是空的）。
- **publish 需 PTY**：`tari publish` 无 TTY 报 "not a terminal"，用 `script -qec "..." /dev/null` 包一层。

### C. 跑仪表盘（连本地 swarm）
> 本地 swarm / esmeralda / 两个 walletd / 仪表盘之间是什么关系、为什么 state 文件要按链分开，见 `docs/environments.md`。
```bash
make dashboard    # http://localhost:8787
```
或手动（和当前这台机器在跑的一致）：
```bash
cd web && AGENTPAY_STATE_FILE=$PWD/server/state.local.json \
  AGENTPAY_WALLETD_URL=http://127.0.0.1:12010/json_rpc \
  AGENTPAY_BUDGET_TEMPLATE=<make publish-local 输出的 agent_budget 地址> \
  AGENTPAY_OWNER_ACCOUNT=default PORT=8787 HOST=127.0.0.1 node server/server.js
```
> **仪表盘 state/txlog 不入库**，所以新机器是全新账本：在新 swarm 上重新「开预算」即可。
> 模板地址每次 `publish-local` 都会变，务必把 `AGENTPAY_BUDGET_TEMPLATE` 指到**当前**发布的地址，
> 否则 `pay` 会报参数个数不符（旧模板 `pay` 签名不同）。

演示：`make demo`（中文终端走一遍「付款被链限额拦住」）、`make demo-otc`。

---

## 3. 必须手动带走的东西（git clone 带不过来）

1. **WSL 私链环境**（最费事）：Ubuntu 里的 Rust/CLI、`node-binaries/`、swarm 工作目录、已领币的账户、
   已发布的模板地址，全在当前这台机器。两条路：
   - **重搭**：按 §2.A/§2.B 从零装（二进制用 `fetch-binaries.sh` 重下）。干净但要踩一遍上面的坑。
   - **整盘搬**（最快保留账户+已发布模板）：旧机器 `wsl --export Ubuntu-24.04 ootle.tar`，新机器
     `wsl --import`。连带把资金、链状态、CLI 都带过去。
2. **内存笔记**：已复制进仓库 **`docs/memory/`**（随 git 走，clone 就带着）。想让新机器的 Claude
   会话「活」地召回这些记忆，把 `docs/memory/*.md` 拷到 Claude 内存目录
   `%USERPROFILE%\.claude\projects\<项目>\memory\`（本机原位置 `C:\Users\cam\.claude\projects\F--oolte\memory\`）。
   详见 `docs/memory/README.md`。关键几条也已折进本文件 §5。
3. **esmeralda 相关**：见 `docs/esmeralda.md`。**2026-11-01 已在新机器重发当前 `agent_budget` =
   `template_88b112610740f457bcc04be70740edebc53c132885a3dda928b1c068d98db8f6`**，并用 SDK 做了真链确认付款；
   发布账户是新充值的 `STBZ`（`component_63d78f7d…`，密钥在新机器 `ootle-dev` WSL 的 walletd 里）。旧 `dev`
   账户的密钥只在旧机器。旧 `299d49bc…`（3 参 `pay`）已作废，别再指向它。**escrow 也已重发** =
   `template_11dc03f70679e981afc5e2e48e261a74be54f87f71e35a6977313f34bbd49d09`（显式 `payer` 版）；旧 `7de6…` 作废。

---

## 4. 怎么验证改动（工作流）

本项目一直是「本地改 → WSL 验 → commit → push → 看 CI 绿」。几条实操注意：

- **Rust/Python/Node 都在 WSL 跑**。Windows 的 node 不在 Git Bash PATH 里。
- **不要在 `/mnt/f` 上 `npm install`/`tsc`**：9p 挂载盘会把 `node_modules/typescript/package.json` 读花
  （"Unexpected token"）。把 `clients/ts` 复制到 WSL ext4（如 `~/ts_ci`）里 `npm install && npm test`，
  再把产出的 `dist/*.js`（**排除 `*.test.js`**）拷回仓库。
- **`clients/ts/dist/` 是入库的，服务器运行时直接加载它**。改了 `clients/ts/src/*.ts` 必须重建 dist 并把
  对应 `.js` 一起提交，否则跑的还是旧逻辑（web CI 的 server 也加载committed dist）。
- **`wsl bash -lc '...'` 里 for 循环变量 `$f` 不展开**：别用循环，显式逐条命令。
- CRLF 警告是换行规范化，无害。
- **仓库放在网络盘（WebDAV/RaiDrive 的 `Y:`）时**：git 要先 `git config --global --add safe.directory <路径>`（UNC 和盘符两种都加）；
  WSL 翻译不了 `Y:` 路径，进不去这个仓库；**不要在网络盘上 `npm install`/`tsc`**（和 /mnt 9p 一样会把 `node_modules`
  读花，tsc 报 undici-types 语法错误）——把 `clients/ts/src` + `package.json` + `tsconfig.json` 拷到本地盘（如临时目录）
  构建，再把 `dist/*.js` + `*.d.ts`（排除 `*.test.*`）拷回。Python/Node 测试在 Windows 原生直接跑没问题。

---

## 5. 关键踩坑速查（命脉，换机器照样适用）

- **事件 topic 命名空间**（最近刚踩）：引擎把模板事件 topic 加结构体名前缀，真实是 `"AgentBudget.pay"`
  不是裸 `"pay"`。按裸 `"pay"` 过滤会丢掉**所有**付款事件 → 仪表盘「动态」账本显示 0 笔（钱其实扣了）。
  正解：按 topic **末段** `== "pay"` 匹配（排除 `pay_via_escrow`/`pay_fee`）。两个客户端都改过了
  （`budget.ts` / `onchain.py`），`reconcileAll` 还会给已确认但无 event 的旧付款从链上回填。见内存
  `event-topic-namespacing`、commit `eac1c6c`。
- **链是权威**：余额/花费/限额/白名单每次都读链，本地只存历史和配置快照；别用本地累加器算花费
  （窗口滚动会漂移误拒）——从 pay 事件的 `spent_in_window` 读。
- **提交的模糊性 = unknown，绝不自动重提**：网络超时/抛错的提交可能已上链，记成 `pending/unknown` 交对账，
  不能当 rejected 也不能重发（H5 防双花）。开预算的 unknown 还会在对账时找回并挂载组件（#3）。
- **badge 要从组件链上状态读**，不能按地址排序猜哪个是 owner/agent。
- **manifest 注入**：所有拼进 manifest 的值在 builder 底层强校验（memo 拒危险字符、地址严格正则）。

---

## 6. 待办 + 评审历史

**第 7 轮评审的所有项已完成。** 2026-11-01（新机器）这一批做了：
- **#8 / phase-1 ✅**：`BudgetManager` / `AgentWallet`（及 `OpenResult`/`PaymentProof`/`SweepResult`）从 SDK `__all__` 移除，
  `agentpay.EXPERIMENTAL` 列出实验性名字，`budget.py` / `ootle_chain.py` 顶部加 EXPERIMENTAL 说明，`sdk/README.md` 重写
  （改掉 "Private stablecoin" 定位、`>=3.13` 安装要求、不存在的 `tools.py`）；新增 `sdk/tests/test_public_api.py`。
- **TS 客户端资源参数化**（与 Python 对齐）：`open({ resource })` / `topUp` 用 `XTR` 或校验过的 `address!("resource_…")`；
  新增 `budget.resource.test.ts`；dist 已重建。
- **文档对齐代码**：README/ci.md 的"尚未激活 GitHub Actions"改为已在跑 + 测试计数更新；api.md/openapi.json 补上
  `Idempotency-Key` 必填、`/api/v1/keys` 列表与撤销端点、白名单移除的真实限制（模板有 `remove_merchant`，是客户端/API 没暴露）；
  web README/DEPLOYMENT 的 HOST 默认改为 `127.0.0.1`；MCP README 的默认模式改为 attach（provision 需 `AGENTPAY_AUTO_PROVISION=true`）；
  interfaces.md 的 Escrow `refund`/`dispute` 行、custody.md 的 badge 顺序、security.md 测试数、audit-notes §1/§2 表格的过时格子。
- TS 客户端 README 许可证 MIT → BSD-3-Clause。
- **`remove_merchant` / `set_limits` 三层接通 ✅**（模板未改）：TS `removeMerchant`/`setLimits`、Python `remove_merchant`/`set_limits`
  （都走 builder 底层校验）；仪表盘 OPS 注册 `removeMerchant`/`setLimits`（admin、highRisk、step-up 参数绑定 merchant / perTxCap+dailyCap、
  `runChainOp` 幂等 + `snapshotBudget`），路由 `POST /api/merchants/remove`、`POST /api/limits`；`/api/v1` 的 `DELETE /merchants/:name`
  改为真正链上移除（本地别名保留，便于按名重加），新增 `POST /api/v1/budget/limits`；治理页白名单 chip 带 ✕ 移除 + "支出限额"表单（中英）。
  测试：TS 注入/形状、Python、`stepup.test.js` 的 setLimits/removeMerchant 参数绑定用例；api.md / openapi.json / web README 已同步。

**仍待办（需要人拍板/链环境）**：
- ~~三个模板 `lib.rs` 的版权头仍是 `Copyright 2026 The Tari Project`~~ ✅ 2026-11-02 统一为 `Copyright 2026 The AgentPay Authors`（三模板源码+测试、`Cargo.toml` authors、新增根 `LICENSE`、`sdk/LICENSE`）。
- API key → 链上会话映射（每 key 一个 session badge）未做。
- ~~`remove_merchant` / `set_limits` 还没在本地 swarm 上真实跑过~~ ✅ 2026-11-02 `scripts/e2e_onchain_admin.py`
  在本地 swarm 真链通过：移除后 pay 被验证节点拒（`Merchant is not whitelisted`）、加回后可付、`set_limits` 后超 1 单位被拒、
  恰好等于新上限通过、日上限压到已花额之上触发 `daily cap`。已并入 `make e2e` / `ci-local.sh`（仍是 `RUN_E2E=1` 门控）。
- ~~esmeralda 上重发当前 `agent_budget`~~ ✅ 2026-11-01 完成（`template_88b11261…`，真链确认付款通过）；
  escrow 也重发为 `template_11dc03f7…`（第一次被 `Insufficient fees paid` 拒，`--max-fee 1600000` 后成功）。
  ~~`pay_via_escrow` 在 esmeralda 上尚未实跑~~ ✅ 2026-11-02 `scripts/e2e_onchain_escrow.py` 在 esmeralda 通过
  （预算 `component_2a785e3f…`，escrow `component_5cb0a1c3…`，`released` 事件 payee 380 / fee 20）；公网 indexer-b 当天
  仍偶发 30s 超时，SDK 按设计不重发，确认钱包没记录该 tx 后整条重跑即可。
- ~~新机器的 WSL 是空的~~ ✅ 已在 I 盘建好 `ootle-dev`（二进制、Rust、tari CLI、模板 ext4 副本、esmeralda walletd，
  本地 swarm 已 init 并发布三模板，见 §3.B）。细节见 `docs/memory/ootle-dev-wsl-on-i-drive.md`。

**已完成**：7 轮外部评审的真实 bug 已逐条修复并带攻击场景回归测试（合约授权/资金、提交模糊性、
幂等、部署加固、OTC 冻结、非托管部署、许可证统一 BSD-3、仪表盘链为权威、集成 API、稳定性 harness、
付款 badge 证明、manifest 注入、开预算 unknown 恢复、付款事件 topic）。细节见各 commit 和
`docs/audit-notes.md`；评审往来文档在仓库根的几个中文 `.md`（未入库）。

**esmeralda 上链**：三模板当前版本都已上链并真链验证（含 `pay_via_escrow`），见 `docs/esmeralda.md`。

---

## 7. 内存笔记清单（已入库 `docs/memory/`）

以下笔记已复制进仓库 `docs/memory/`（随 clone 带走；想让 Claude 活用见 §3.2 和 `docs/memory/README.md`）：

| 文件 | 主题 |
|---|---|
| `tari-dev-needs-linux` | 为什么必须 Linux/WSL（模板测试 + CLI 的硬阻塞） |
| `local-swarm-devnet` | 本地私链可复现配方（版本匹配/walletd/token/领币/publish） |
| `event-topic-namespacing` | 事件 topic 命名空间坑（本次付款账本 bug 的根因） |
| `web-chain-authority` | 仪表盘链为权威 + tx 生命周期/幂等/对账 |
| `stability-b6` | 稳定性 harness（mock walletd 驱动真后端） |
| `integration-api-b5` | /api/v1 M2M REST + API key 分级鉴权 |
| `ts-client-phase6` / `web-dashboard-phase7` | TS 客户端 / 仪表盘落地 + 踩坑 |
| `agent-budget-phase2` / `escrow-template-phase1` / `otc-board-phase4` | 三模板实现要点 |
| `agentpay-phase3` / `agentpay-mcp-integration` | SDK 接链 / MCP 集成 |
| `security-correctness-pass` / `contract-audit-pass` / `manifest-injection-fix` / `payment-badge-proof-fix` | 各安全修复轮 |
| `esmeralda-deploy` / `esmeralda-deploy-blocked` | 公共测试网上链（含拥堵阻塞） |
| `phase5-launch-prep` | 压测 + 中英 README + 文档 |

关键几条已折进 §2–§5，即使不碰 `docs/memory/` 也能干活。

---

*接手第一步建议：`git clone` → `make ci` 看绿 → 需要真链再 `make swarm-up` + `make dashboard`。
剩下的唯一评审项是 #8。*
