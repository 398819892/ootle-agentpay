---
name: otc-board-phase4
description: Phase 4 完成 — OtcBoard P2P 场外托管模板(12 测试)，已上链 + OTC 流程链上演示跑通
metadata:
  node_type: memory
  type: project
  originSessionId: 30883ce1-2799-45ad-b5e4-1944cba09e7d
  modified: 2026-10-22T05:20:10.024Z
---

Phase 4 完成：`OtcBoard` P2P 场外托管撮合板模板 + 12 个 cargo 测试全绿，已发布上链并做了 OTC 流程链上演示。源码 `F:\oolte\templates\otc_board\`，WSL 副本 `/root/ootle/otc_board`。见 [[escrow-template-phase1]] [[local-swarm-devnet]]。

**设计（每单内嵌 escrow 逻辑，OTC 角色显式）：**
- 卖方 `list(asset, bond, seller_account, terms_hash, arbiter_pk, timeout)` → 锁资产+保证金，状态 Open，返回 listing_id。seller=CallerContext 签名者。
- 买方 `take(id, buyer_account, buyer_pk, hashlock?)`：Open→Taken，设 deadline。**buyer 身份是传参**（不靠签名者）。
- `confirm(id, preimage?)`：seller 或 原像持有者 → 资产给买方(扣费)、保证金还卖方、费进 treasury，状态 Settled。
- `reclaim(id)`：卖方超时后退回资产+保证金，Refunded。`cancel(id)`：Open 时卖方取消退回。
- `open_dispute(id)`（买/卖）→ Disputed；`resolve(id, to_buyer_amount)`（仲裁人）按比例分，保证金还卖方。
- owner（owner_badge gated）：add_arbiter/remove_arbiter/set_params。
- **防作恶**：listing_bond（挂单保证金）、max_listing_amount（单笔上限）、arbiter_whitelist（仲裁人白名单）。
- 为什么不用跨模板 Escrow：Escrow::new 的 payer=CallerContext 签名者，买方接单时开 escrow 会把 payer 记成买方（角色错位）。所以 OtcBoard 内嵌 escrow 逻辑、用存储的 seller/buyer 公钥做角色。跨模板实例化由 [[agent-budget-phase2]] 的 pay_via_escrow 验证。

**已验证：** 12/12 cargo 测试（挂单/接单/确认/原像确认/取消/超时退回/争议分配 + 防作恶 3 项 + owner 权限，用独立 seller/buyer/arbiter 账户）。发布上链 `template_8bfa294dc89b6fdccccb123becaee056d0c250f9c1613d06b7c8571d10cb0ff1`。链上演示 `F:\oolte\ootle-bin\otc_demo.py`（list→take→confirm，买方收 950 / treasury 50，5% 费）跑通。

**链上演示注意：** manifest 里 `Hash32` 参数用 `hex_bytes!("<64hex>")`；OTC 多签名者（seller/buyer/arbiter）在 walletd 下复杂，演示让 seller/arbiter/owner=default 共签，buyer/treasury 独立账户收款——角色分离正确性靠 cargo 测试保证。
