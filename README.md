# Ootle AgentPay & OTC Escrow

On-chain escrow, agent spending budgets, and a P2P OTC board — built as Tari Ootle (L2) WASM
templates, driven from Python. Limits are enforced **on chain by the validator**, not by a client.

> 链上托管、AI 代理支付预算、P2P 场外托管撮合板 —— 用 Tari Ootle (L2) WASM 模板实现，Python 驱动。
> 限额由**验证节点在链上强制**，不靠客户端自觉。

---

## English

### What's here

Two products on one shared escrow core:

1. **AgentPay (on-chain)** — a spending wallet for an AI agent. The owner funds it and hands the
   agent a session badge; the agent can only spend within chain-enforced rules: a per-transaction
   cap, a rolling daily cap, a merchant whitelist, and an instant kill switch. The client's own
   limit check is only a friendly early error — the chain is authoritative.
2. **Private P2P OTC escrow** — sellers list an asset (locked in escrow), a buyer takes it and pays
   off chain, then the asset is released / refunded on timeout / split by an arbiter on dispute. The
   platform earns a fee per deal.

### Templates (Rust → WASM)

| Template | What it does | Tests | Published (localnet) | Published (esmeralda) |
|---|---|---|---|---|
| **Escrow** | Lock funds; release (opt. hashlock) / refund after timeout / dispute → arbiter resolves; platform fee | 17 ✅ | `template_9b230fab…` | `template_7de6ee2d…` |
| **AgentBudget** | Owner/agent badges; `pay` within per-tx + rolling-daily caps + whitelist; revoke; `pay_via_escrow` (cross-template) | 10 ✅ | `template_758d0c58…` | `template_299d49bc…` |
| **OtcBoard** | List/take/confirm/reclaim/dispute/resolve; listing bond, max-amount cap, arbiter whitelist + **arbiter stake/slash** | 16 ✅ | `template_8bfa294d…` | `template_bafbe76e…` |

All three are deployed to a local swarm **and to the public esmeralda testnet**, and exercised with
**real on-chain calls** (not just unit tests): see the demos below. Full esmeralda addresses and the
deployment method are in [`docs/esmeralda.md`](docs/esmeralda.md).

### Python SDK (`ootle-agentpay`)

The existing `ootle-agentpay` SDK gains `agentpay.onchain` (`OnChainBudget` / `WalletdClient`): a
stdlib-only adapter that drives the `AgentBudget` template through a wallet daemon's JSON-RPC
(transaction manifests). The invoice/memo codec is unchanged (rides along as the on-chain memo);
a watcher rebuilds the local ledger from the chain's `pay` events.

### Quick start

Dev happens on Linux (the Tari engine's wasmer/cranelift backend doesn't build on Windows). This
repo was built on **WSL Ubuntu**.

```bash
# 1. toolchain (in WSL)
rustup target add wasm32-unknown-unknown
cargo install tari-ootle-cli            # the `tari` CLI

# 2. test a template
cd templates/escrow && cargo test        # (likewise agent_budget, otc_board)

# 3. a local network (prebuilt binaries, no source build) + publish
#    see docs/devnet.md for the swarm setup; then:
tari -n localnet publish -a default -y --wallet-daemon-url http://127.0.0.1:12010/json_rpc

# 4. demos against the live swarm (Python, stdlib only)
cd sdk && PYTHONPATH=src python examples/demo_devnet.py   # agent budget, on-chain
PYTHONPATH=src python examples/stress_devnet.py 20        # randomised stress vs reference model
python ../scripts/otc_demo.py                             # OTC list→take→confirm, on-chain
```

### Status & verification

- **43 template unit tests** (Escrow 17, AgentBudget 10, OtcBoard 16) pass in the wasmer sandbox,
  including adversarial/boundary cases (double-release, over-balance resolve, fee truncation) and
  the arbiter stake/slash flow.
- **On-chain**: all three templates published to a local swarm; Escrow release, AgentBudget pay /
  cap-rejection / revoke, and OtcBoard list/take/confirm verified with real transactions and
  balance checks.
- **SDK**: 46 Python tests pass (business logic + the 10 new on-chain-adapter tests).
- See `docs/security.md` for the trust model, known limitations, and audit-prep notes.

---

## 中文

### 这是什么

两个产品共用一个托管核心：

1. **AgentPay（链上版）**：给 AI 代理用的支付钱包。所有者充值并给代理发一个会话凭证（badge）；
   代理只能在链上强制的规则内花钱——单笔上限、每日（epoch 窗口）上限、商户白名单、随时撤销的急停
   开关。客户端自己的限额检查只是「提前友好报错」，以链上为准。
2. **隐私 P2P 场外托管**：卖方挂单（资产锁进托管），买方接单并链下付款，然后放币 / 超时退回 /
   争议由仲裁人按比例分配。平台按笔收手续费。

### 模板（Rust → WASM）

| 模板 | 作用 | 测试 | 已发布(localnet) | 已发布(esmeralda) |
|---|---|---|---|---|
| **Escrow** | 锁资金；放款(可选 hashlock)/超时退款/争议→仲裁；平台手续费 | 17 ✅ | `template_9b230fab…` | `template_7de6ee2d…` |
| **AgentBudget** | owner/agent 双 badge；`pay` 受单笔+日窗口上限+白名单约束；撤销；`pay_via_escrow`(跨模板) | 10 ✅ | `template_758d0c58…` | `template_299d49bc…` |
| **OtcBoard** | 挂单/接单/确认/退回/争议/分配；挂单保证金、单笔上限、仲裁人白名单 + **仲裁人质押/罚没** | 16 ✅ | `template_8bfa294d…` | `template_bafbe76e…` |

三个模板都已部署到本地链**以及公共测试网 esmeralda**,并用**真实链上调用**验证过（不只是单测）。
esmeralda 完整地址与部署方法见 [`docs/esmeralda.md`](docs/esmeralda.md)。

### Python SDK（`ootle-agentpay`）

现有的 `ootle-agentpay` SDK 新增了 `agentpay.onchain`（`OnChainBudget` / `WalletdClient`）：纯标准库
适配器，通过钱包守护进程的 JSON-RPC（交易 manifest）驱动 `AgentBudget` 模板。发票/备注编解码不变
（原样作为链上 memo）；监听器从链上 `pay` 事件重建本地账本。

### 快速开始

开发在 Linux 上做（Tari 引擎的 wasmer/cranelift 后端在 Windows 不编译）。本项目在 **WSL Ubuntu** 上构建。

```bash
# 1. 工具链（WSL 里）
rustup target add wasm32-unknown-unknown
cargo install tari-ootle-cli            # tari CLI

# 2. 测试模板
cd templates/escrow && cargo test        # agent_budget、otc_board 同理

# 3. 本地网络（预编译二进制，免源码编译）+ 发布
#    swarm 搭法见 docs/devnet.md，然后：
tari -n localnet publish -a default -y --wallet-daemon-url http://127.0.0.1:12010/json_rpc

# 4. 对活链的演示（Python，纯标准库）
cd sdk && PYTHONPATH=src python examples/demo_devnet.py   # 代理预算，链上
PYTHONPATH=src python examples/stress_devnet.py 20        # 随机压测 vs 参考模型
python ../scripts/otc_demo.py                             # OTC 挂单→接单→确认，链上
python ../scripts/otc_stake_demo.py <OtcBoard模板地址>    # OTC 仲裁人质押/罚没，链上
```

> 带质押/罚没的 OtcBoard 已发布到本地链：`template_dd8e9b31…2fd32c97`
> （`python scripts/otc_stake_demo.py template_dd8e9b31…` 跑完整演示）。

### 直观上手（推荐先玩这两个）

链跑起来后，有两种"看得懂"的方式亲手测试，不用懂命令行细节：

```bash
# ① 一键中文讲解：终端里一步步演示 AgentPay 的链上限额,每步说明"证明了什么"
python scripts/demo_zh.py            # 回车逐步;加 --auto 一口气跑完;加 --otc 看场外托管流程

# ② 本地 Web 控制台：浏览器里点按钮,实时看余额/限额变化(最直观)
python scripts/console.py            # 然后打开 http://127.0.0.1:8700
```

Web 控制台里:开预算 → 正常付款(成功、余额减)→ 试试超额/非白名单(被链当场拒,显示验证节点
给的理由)→ 撤销急停 → 提现。每个按钮都向本地链提交真实交易,一眼看懂"限额是链在拦,不是前端装样子"。

### 状态与验证

- **43 个模板单测**（Escrow 17、AgentBudget 10、OtcBoard 16）在 wasmer 沙箱通过，含对抗/边界用例
  （重复放款、超额分配、手续费截断）和仲裁人质押/罚没流程。
- **链上**：三个模板都发布到本地 swarm **以及公共测试网 esmeralda**；Escrow 放款、AgentBudget
  付款/超额拒绝/撤销、OtcBoard 挂单/接单/确认都用真实交易 + 余额核对验证过。
- **SDK**：46 个 Python 测试通过（业务逻辑 + 10 个新的链上适配器测试）。
- 信任模型、已知限制、审计准备见 `docs/security.md`。

### 定位与局限（务必读）

- **主打 AgentPay(AI 代理可控支付中间件)**，这是更垂直、更有差异化的场景；OTC 托管板是共用托管核心的
  可选模块，后置打磨。
- **三条对用户的关键披露**（详见 `docs/security.md` 的“对最终用户的披露”）：① 余额和每笔金额在链上**公开**，
  链保证的是“花不超限”而非“花了不被看见”；② 时间按 **~30 分钟的 epoch** 计，“每日限额/超时”都是 epoch 窗口；
  ③ 仲裁人是**被信任方**（现有白名单 + 质押/罚没约束，但单次裁决仍依赖其诚实）。
- **不绑定单一代币**：模板对任意明文可计数资源都能用（`docs/spike.md`），便于日后迁移，降低对单一生态依赖。
- **已上公共测试网**：三个模板已部署到 esmeralda（账户充值与发布的完整方法见 `docs/esmeralda.md`）。
  充值卡点（公共 faucet 领币需 SDK 构造 claim+付费交易、manifest 表达不了）已用自建 Rust 交易构造器绕过。

---

## Repo layout

```
templates/        escrow · agent_budget · otc_board — Rust→WASM 模板 + 测试
sdk/              ootle-agentpay Python SDK —— onchain 链上适配器 + demos + tests
site/             index.html —— 产品一页介绍网页（也发布为在线 Artifact）
docs/             spike · interfaces · security · devnet 四份文档
scripts/          发布 / 演示 / 辅助脚本（otc_demo.py, call-escrow.py, publish-*.sh …）
node-binaries/    bins/ 预编译 Tari 节点二进制（跑本地 swarm 用；可从官方 release 重新下载）
wasm-template/    官方模板仓库克隆（参考，纯源码，无构建产物）
```

Templates not bound to a single token: each works with any plaintext countable resource
(confidential amounts can't be range-checked inside a template — see `docs/spike.md`).

License: BSD-3-Clause.
