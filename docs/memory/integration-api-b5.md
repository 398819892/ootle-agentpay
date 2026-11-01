---
name: integration-api-b5
description: B-5 产品化集成 API /api/v1（API key 鉴权，第三方/agent 调托管服务）已完成
metadata:
  node_type: memory
  type: project
  originSessionId: d36672d5-4b7f-45e9-990f-105ad58cb3e5
  modified: 2026-10-27T04:45:51.246Z
---

B-5 把 AgentPay 做成第三方可集成的 M2M REST API。本地 commit `9cbacda`（master，未 push）。

- **surface**：`web/server/apikeys.js`（新，bearer key，env `AGENTPAY_API_KEYS="role:id:secret"`，
  role=agent|admin，sha256 恒定时间校验，吊销持久化在 store.apiKeys.revoked；没配 key 则 /api/v1 关闭 503）
  + server.js 里 `handleApiV1`（在浏览器 session/CSRF 门**之前**分发，用 key 鉴权，不削弱那道门）。
- **端点**：`POST/GET /api/v1/payments`(+/:id，Idempotency-Key→回执，幂等不重复上链)、`GET /budget`、
  `GET/POST/DELETE /merchants`、`POST /budgets`(admin 开预算)、`GET /audit`(admin)、`GET /api/v1`+
  `/openapi.json`(无鉴权)。分级：agent 付款+读；admin 另可开预算/注册商户/读审计（agent 越权→403）。
  高危 op 的 step-up：admin key 即强凭证，v1 适配器服务端代铸 confirmToken。
- **复用**现有 authorizer/txlog(幂等+生命周期)/审计/链上权威读，没重造。
- **客户端/示例**：`clients/ts/src/api.ts`(薄 AgentPayApiClient，dist 已重建) + `examples/`(curl/Node/Python)。
- **文档**：`docs/api.md`(参考+集成指南+已知限制+TODO) + `web/public/openapi.json`。
- 自测本地 swarm 六条证据齐（见 side-session-notes/b5-integration-api.md）。pay 仍因 [[local-swarm-devnet]]
  模板漂移 reject，API 正确当回执透出；confirmed 生命周期用 createBudget 证。
- TODO：每 key 限额/配额、webhook、密钥轮换/管理 API、细粒度 scope、分页。

相关：[[web-dashboard-phase7]] [[web-chain-authority]] [[security-correctness-pass]] [[ts-client-phase6]]
