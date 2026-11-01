---
name: phase5-launch-prep
description: Phase 5 上线准备完成 — 压测 + 中英 README + 接口/安全/devnet 文档
metadata:
  node_type: memory
  type: project
  originSessionId: 30883ce1-2799-45ad-b5e4-1944cba09e7d
  modified: 2026-10-22T05:25:32.829Z
---

Phase 5（上线准备）可交付部分完成。见 [[otc-board-phase4]] [[agentpay-phase3]] [[local-swarm-devnet]]。

**交付物：**
- `F:\ootle-agentpay\ootle-agentpay\examples\stress_devnet.py` — 随机付款压测，对照独立参考模型验证「链上 accept ⟺ 规则允许」。跑 20 轮：9 接受/11 拒绝/**0 mismatch，PASS**。可调 ROUNDS 做长跑 soak。
- `F:\oolte\README.md` — 中英双语总 README（两产品、三模板表 + 已发布地址、SDK、快速开始、验证状态）。
- `F:\oolte\docs\interfaces.md` — 三模板完整接口参考表。
- `F:\oolte\docs\security.md` — 信任模型、链上vs链下、7 条已知限制、攻击面、审计准备清单。
- `F:\oolte\docs\devnet.md` — 本地 swarm 搭建 + manifest 调用 + esmeralda 说明（汇总踩坑）。

**做不了的（外部动作）：** 真实 esmeralda 部署（公共 faucet 空，需 L1 烧币）、社区资助申请、实际合约审计——但 security.md 的审计清单 + 已知限制为这些做了准备。

**全项目状态（Phase 0→5）：** 三模板 Escrow(13)/AgentBudget(10)/OtcBoard(12) 共 35 单测 + 46 Python 测试全绿，都已发布本地链并真实调用验证；压测 0 mismatch。模板地址：Escrow `template_9b230fab…`、AgentBudget `template_758d0c58…`、OtcBoard `template_8bfa294d…`。
