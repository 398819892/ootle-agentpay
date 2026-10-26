# Ootle DApp 开发计划（交给 Claude Code 执行）

> 用法：把本文件放进项目根目录，对 Claude Code 说：
> “读 ootle-plan.md，从阶段 0 开始做，每完成一个阶段停下来给我看测试结果。”

## 产品目标

两个产品共用一个核心托管模板：

1. **AgentPay 链上版**：给 AI 代理用的支付钱包，限额由链上合约强制执行（单笔上限、每日上限、商户白名单、可随时撤销），不靠客户端自觉。
2. **隐私 P2P 场外托管**：卖方锁币 → 买方付款 → 释放；超时自动退回；争议由仲裁人裁决；平台按笔收手续费。

技术栈：Tari Ootle 模板（Rust → WASM），客户端用 `ootle-rs` 或现有的 `ootle-py`（ootle-agentpay 项目）。

---

## 给 Claude Code 的规则

- **不要凭记忆写 Ootle API。** 每用一个 `tari_template_lib` 的类型或函数，先在官方仓库 `tari-project/wasm-template` 的 `examples/` 和 crate 文档里找到真实用法再写。找不到就停下来问我。
- 每个模板必须有单元测试 + 失败路径测试（越权调用、超额、超时前退款等都要测到会失败）。
- 金额统一用最小单位整数，不用浮点。
- 每个阶段结束：跑全部测试，列出“已完成 / 未验证 / 下一步”。

---

## 阶段 0：环境与可行性验证（先做，最重要）

1. 安装 CLI：`cargo install tari-ootle-cli`（二进制叫 `tari`）。
2. `cargo generate https://github.com/tari-project/wasm-template` 生成工作区，跑通 `examples/guessing_game`（模板 + CLI）。
3. 搭本地网络或连 devnet，启动钱包守护进程，用 `tari publish` 部署 guessing_game 成功一次。
4. **可行性调研（写成 `docs/spike.md`）**，必须回答：
   - 模板里能否读取当前时间 / epoch？精度多少？（超时退款和“每日上限”依赖它）
   - 保密（confidential）资源的金额，模板内部能不能读到？
     - 如果读不到：限额检查怎么做？可选方案：(a) 代理钱包里用明文资源，仅对外转账保密；(b) 依赖范围证明；(c) 限额只针对明文稳定币。列出利弊。
   - 访问控制怎么做：用 badge（NFT 凭证）+ `rule!` 还是 `CallerContext`？
   - 调用另一个组件（跨模板调用）的写法。
   - 事件 `emit_event` 的用法，客户端怎么订阅。

**交付物**：能部署的 hello 模板 + `docs/spike.md`。阶段 0 结论如果推翻后面的设计，先停下来找我。

---

## 阶段 1：核心托管模板 `Escrow`

状态机：`Open → Released | Refunded | Disputed → Resolved`

接口（伪代码，以真实 API 为准）：

| 方法 | 调用者 | 作用 |
|---|---|---|
| `new(funds, payee, hashlock?, timeout, arbiter?, fee_bps)` | 付款方 | 锁入资金，创建托管 |
| `release(preimage?)` | 付款方 或 持有原像者 | 放款给收款方，扣手续费进平台金库 |
| `refund()` | 付款方 | 仅在超时后可调用 |
| `dispute()` | 任一方 | 进入争议，冻结 |
| `resolve(to_payee_amount)` | 仲裁人 | 按比例分配 |
| `get_state()` | 任何人 | 只读 |

测试清单：
- 正常放款、原像错误放款失败、超时前退款失败、超时后退款成功
- 非仲裁人调用 `resolve` 失败、重复放款失败
- 手续费计算正确（含 0 费率和上限）

---

## 阶段 2：`AgentBudget` 模板

所有者（人）存入资金，给代理发一个“会话凭证”（badge），代理只能在规则内花钱。

字段：`owner_badge`、`agent_badge`、`vault`、`per_tx_cap`、`daily_cap`、`spent_today`、`day_start`、`merchant_whitelist`、`revoked`

接口：
| 方法 | 调用者 | 作用 |
|---|---|---|
| `new(funds, per_tx_cap, daily_cap, whitelist)` | 所有者 | 创建，返回 owner/agent 两个 badge |
| `pay(merchant, amount, memo)` | 代理 | 检查：未撤销、在白名单、≤单笔上限、当日累计≤日上限；通过才转账，发事件 |
| `pay_via_escrow(...)` | 代理 | 不直接付，而是开一个 `Escrow`（商户交付后再放款） |
| `set_limits / add_merchant / remove_merchant` | 所有者 | 改规则 |
| `revoke()` | 所有者 | 立即冻结代理 |
| `withdraw(amount)` | 所有者 | 取回余额 |

测试清单：超单笔、超日限、跨日重置、非白名单、撤销后支付、代理调用所有者方法——全部应失败。

---

## 阶段 3：接入现有 ootle-agentpay（Python）

1. 链适配器改为调用 `AgentBudget` / `Escrow` 组件，客户端的限额检查保留但仅作“提前报错”，以链上为准。
2. 发票/备注编解码不变，作为 `memo` 传入。
3. 监听合约事件，更新本地账本。
4. 更新 `demo_offline.py`，新增 `demo_devnet.py` 走真实网络全流程。

---

## 阶段 4：P2P 场外托管产品

1. `OtcBoard` 模板：卖方挂单（资产锁进 `Escrow`，条款摘要上链，详细条款加密放链下）。
2. 买方接单 → 链下付款 → 卖方或原像机制放币；超时退回；争议走仲裁人。
3. 平台收入：每笔 `fee_bps` 进平台金库组件，所有者可提取。
4. 简单前端或 CLI：挂单、接单、确认、争议。
5. 防作恶：挂单保证金、仲裁人白名单、单笔上限。

---

## 阶段 5：上线准备

- 部署到 testnet，跑一周脚本化压力测试（随机下单/超时/争议）。
- 写 README（中文 + 英文）和合约接口文档。
- 申请 Tari 社区资助或生态计划（工具 + 应用两个方向都可以申请）。
- 主网前找人做合约审计。

---

## 风险与待定事项

- Ootle 主网时间、隐私稳定币何时发行：不确定。合约设计成支持任意资源地址，不绑定单一币种。
- 保密金额与限额检查可能冲突：以阶段 0 调研结论为准。
- 场外交易涉及各地法规（KYC/反洗钱），上线前需确认运营地合规要求。
