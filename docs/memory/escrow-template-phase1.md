---
name: escrow-template-phase1
description: Phase 1 Escrow 模板已完成（13/13 测试通过）+ 模板写作踩过的坑
metadata:
  node_type: memory
  type: project
  originSessionId: 30883ce1-2799-45ad-b5e4-1944cba09e7d
  modified: 2026-10-21T12:08:45.598Z
---

Phase 1 完成：`Escrow` 托管模板 + 13 个测试全绿（`cargo test`，WSL）。源码在 `F:\oolte\templates\escrow\`（src/lib.rs、tests/test.rs），WSL 构建副本在 `/root/ootle/escrow`。见 [[local-swarm-devnet]] [[tari-dev-needs-linux]]。

**Escrow 设计（真实 tari_template_lib 0.35 API）：**
- 状态机 Open → Released | Refunded | Disputed → Resolved（`EscrowState` 枚举，minicbor derive）。
- **任意资源**：vault 锁 `funds.resource_address()`，不绑定 XTR（符合"任意资源地址"）。
- **访问控制用签名者身份**：存 payer/payee/arbiter 的 `RistrettoPublicKeyBytes`，方法内 `CallerContext::transaction_signer_public_key()` 比对；组件 `AccessRules::allow_all()`，授权在方法里做。（spike 推荐 badge+rule!，但身份比对更易测，Phase 2 AgentBudget 可按需改 badge。）
- 时间 `Consensus::current_epoch()`；hashlock 用 `intrinsics::hash_sha256(&preimage) -> Hash32`；手续费 `amount * fee_bps / 10000`（`Amount: Mul/Div<u64>`），fee_bps≤10000，0 费率跳过 treasury。
- 跨组件转账 `ComponentManager::get(addr).invoke("deposit", args![bucket])`；事件 `emit_event("x", metadata!["k"=>v.to_string()])`。

**模板写作踩的坑（下次直接避开）：**
- Cargo.toml 要显式加 `minicbor = { version = "2.2", default-features = false, features = ["alloc","derive"] }` 才能 derive `#[n(x)]`。
- `Amount` 字段是 `pub(super)`，外部**不能 `Amount(0)`**，用 `amount![0]` 宏（prelude 已导出）。
- lib 的 crate-type 加 `"lib"`（除 `"cdylib"`）才能让集成测试 `use escrow::EscrowState`。
- **测试指令索引**：`put_last_instruction_output_on_workspace` **本身算一条指令**。所以 withdraw=0、put=1、call_function=2 → `expect_return::<ComponentAddress>(2)`。
- 测试拿账户公钥：`RistrettoPublicKey::from_secret_key(&key).to_byte_type()`（需 `tari_template_test_tooling::byte_type::ToByteType` 和 `crypto::PublicKey` trait 在作用域）。
- `expect_return<T>` 需 `serde::DeserializeOwned + tari_bor::Decode`；自定义枚举没加 serde 就别 expect_return 它，改用余额/reject reason 验证行为。
- set_epoch 测超时：`test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(n))`（经 `tari_template_test_tooling::engine_types::virtual_substate`）。
- `TemplateTest::my_crate()` 起测试环境；`args![Workspace("name")]` 的 `Workspace` 是 `args!` 宏内部 token，无需 import。
