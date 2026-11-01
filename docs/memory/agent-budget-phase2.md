---
name: agent-budget-phase2
description: Phase 2 AgentBudget 核心完成（9/9 测试）+ badge 访问控制和两个新踩的坑
metadata:
  node_type: memory
  type: project
  originSessionId: 30883ce1-2799-45ad-b5e4-1944cba09e7d
  modified: 2026-10-22T00:53:01.132Z
---

Phase 2 **全部完成**：`AgentBudget` 模板 + 10 个测试全绿（WSL `cargo test`），含 pay_via_escrow 跨模板集成。已发布上链（localnet）：`template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97`。源码 `F:\oolte\templates\agent_budget\`，WSL 构建副本 `/root/ootle/agent_budget`。见 [[escrow-template-phase1]] [[local-swarm-devnet]]。

**设计（方案 a：明文资源，badge 访问控制）：**
- owner 存入资金，`new` 返回 `(Component, owner_badge, agent_badge)` 两个 non-fungible badge。
- **访问控制用 badge + `rule!`**（不是 Escrow 的 CallerContext 身份）：
  `ComponentAccessRules::new().method("pay", rule!(resource(agent_badge))).method("set_limits"/"add_merchant"/"remove_merchant"/"revoke"/"withdraw", rule!(resource(owner_badge))).default(rule!(allow_all))`。
- `pay(merchant, amount, memo)`：检查 未撤销、amount>0、≤per_tx_cap、商户在白名单、当窗口累计≤daily_cap；通过才 `vault.withdraw` → `invoke("deposit")`，发事件。
- 「每日」= epoch 滚动窗口（`epochs_per_window`，lazy reset：`pay` 时若 `now >= window_start + epochs_per_window` 则清零）。
- owner 方法：set_limits / add_merchant / remove_merchant / revoke / withdraw。getter `get_badges()`（返回两 badge 资源地址，让测试/客户端发现）、`get_info()`。
- **pay_via_escrow 已完成**：owner 先 `configure_escrow(escrow_template, owner_account, treasury, arbiter?, fee_bps)`（不改 new 签名），agent 调 `pay_via_escrow(merchant, merchant_pubkey, amount, timeout, memo) -> escrow_addr`，内部 `TemplateManager::get(escrow_tpl).call::<ComponentAddress>("new", args![...])` 跨模板实例化 Escrow（spike 待验证项坐实）。escrow.payer = 交易签名者（agent）。集成测试用 `TemplateTest::new(".", ["../escrow", "."])` 同时加载两模板。10/10 测试全绿。

**测试清单全覆盖**：超单笔、超日限、跨窗口重置、非白名单、撤销后支付、**代理调用所有者方法（Access Denied）**，加 happy path / set_limits / withdraw。

**badge 证明的测试范式**（owner/agent 账户持 badge，调用 gated 方法时呈现证明）：
```
.create_proof(account, badge_resource)
.put_last_instruction_output_on_workspace("proof")
.call_method(comp, "gated_method", args![...])   // proof 在 workspace 即进入 auth scope
.drop_all_proofs_in_workspace()
.build_and_seal(&account.key)   // proofs: vec![account.owner_token]
```
访问规则拒绝的 reject 文本是 **"Access Denied: {action}"**（断言用 "Access Denied"）。

**两个新踩的坑：**
- **tari_crypto 必须固定 0.24.0**：0.24.1 会让 test tooling 的 `support/stealth.rs` 编译失败（`RistrettoSecretKey::from(123)` 无 `From<i32>`）。新 crate 跑测试前先 `cargo update -p tari_crypto --precise 0.24.0`。
- **资源 token symbol ≤ 10 字节**：`with_token_symbol("...")` 超 10 字节（如 "AGENT-OWNER"=11）会 InvalidArgument。用短符号（OWNER/AGENT）。
