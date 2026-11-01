---
name: web-dashboard-phase7
description: "AgentPay 产品级网页仪表盘(web/),零依赖托管式,本地 swarm 真实跑通"
metadata:
  node_type: memory
  type: project
  originSessionId: f82b6a5c-1abc-4b4d-b397-ec24e5290526
  modified: 2026-10-30T04:35:38.659Z
---

**AgentPay 网页仪表盘** `web/`(Phase 7,2026-10-26 完成),把原型控制台升级成漂亮、符合大众审美的运营方仪表盘。

**架构(安全第一):** 浏览器 → Node 后端 → walletd → 链。浏览器**绝不**直连 walletd。后端 `web/server/server.js` 用 `node:http`,`require('../clients/ts/dist')` 驱动链(只读用编译好的 dist,没改 clients/ts 源)。

**零依赖、无构建:** 后端只用 Node 内置模块;前端是手写 HTML/CSS/JS(`public/`,没用 React/Vite/Tailwind——`clients/ts` 零运行时依赖这点让整个 app 不需要 `npm install`,于是绕开了 WSL /mnt npm install 损坏 node_modules 的坑)。**一条命令:** `wsl bash /mnt/f/oolte/web/run.sh`(或 `node server/server.js`),默认 8787 端口,绑 0.0.0.0 让 Windows 浏览器经 WSL2 localhost 转发访问。

**关键踩坑:** walletd 的 submit_manifest `variables` 把值当 manifest value 解析,账户要用**组件地址**不是名字——直接传 `"default"` 会报 `Invalid manifest value 'default'`。所以后端用 `c.accountAddress("default")` 解析出地址再 `new OnChainBudget(c, template, ownerAddr)`(demo.ts 传名字在这台 walletd 上会失败)。

**功能:** 总览(状态/双 meter/金库/白名单 chips)、创建预算(校验)、付款(流水从链上 pay 事件重建)、治理(加白名单/提现/撤销)。**"链上强制可感知":** Payments 的 "Check on chain" 跑 validator dry-run,把链给的真实拒因友好展示(超单笔/非白名单/超每日/已撤销)。治理只做模板/client 真支持的三件事(add_merchant/withdraw/revoke)——删商户、改限额模板没有,**没造假**。

**体验:** 浅/深/跟随系统主题(localStorage)、完整加载/空/错误态、toast、pending 反馈、地址截断+复制、危险操作二次确认(撤销需勾选确认框才启用按钮)、手机响应式(侧栏变顶栏)。浏览器实测全流程跑通并逐态自检截图通过。

后端用 `web/server/state.json`(gitignore)持久化当前预算,刷新/重启不丢;"Reset demo" 只解绑不删链上组件。详见 [web/README.md]。接着 [[ts-client-phase6]]。

**部署化(Phase 7 续,2026-10-26):** 加了**鉴权 + Docker + 部署文档**,仍零依赖(只用 `node:crypto`)。
- **鉴权:** `DASHBOARD_PASSWORD` 环境变量**一设就开**(不设=本地开发开放模式,不改原体验)。门禁所有 `/api/*`(未登录 401),签名 cookie(HttpOnly,HTTPS 下 Secure),登录失败 per-IP 限流(8 次→锁 10 分),登出。`SESSION_SECRET` 签 cookie。口令/密钥不打日志。前端有登录页 + 401 自动跳登录。实测:无 cookie /api/state→401、错密码→401、对密码→200+Set-Cookie、登出,浏览器登录页三态(正常/错误/成功进面板)都过。
- **Docker:** `web/Dockerfile`(node:18-slim,从 **repo root** build,打包 web/ + clients/ts/dist,无 npm install)、`web/docker-compose.yml`(dashboard + walletd sidecar,**walletd 不映射端口**只走内网)、`.env.example`。state 可用 `AGENTPAY_STATE_FILE` 指到挂载卷。
- **部署文档 `web/DEPLOYMENT.md`:** 安全模型、拓扑图、esmeralda env(walletd http://walletd:5100 + template_299d49bc… + 账户 dev)、两方案(**单 VPS compose+Caddy 自动 HTTPS 推荐** / PaaS 跑面板+walletd 私网隧道)、walletd 诚实说明(需二进制+esmeralda config `indexer_trust=trust`+充值 dev 账户,不是普通 npm 应用)、安全清单。**硬规则:walletd 只绑 localhost/私网,端口绝不公开。**
- 没改 templates/sdk/clients/ts。**本机无 docker**,镜像没实际 build 过(配置是直的)。仓库现在是 git 了(无远程),我没 push。

本项目构建踩坑/当前仓库状态随时间变化,引用文件前先核实存在。

**连 esmeralda 公网跑通(2026-10-30):** 纯 env 切换(没改 web 源)把仪表盘指向 esmeralda:`AGENTPAY_WALLETD_URL=http://127.0.0.1:5100/json_rpc` + `AGENTPAY_OWNER_ACCOUNT=dev` + `AGENTPAY_BUDGET_TEMPLATE=<esmeralda agent_budget>` + `AGENTPAY_STATE_FILE=…state.esmeralda.json`。实测 `connected:true`、owner 解析为 esmeralda 的 dev、Windows localhost 可达、**在 esmeralda 开预算成功上链**。**但确认付款 pay 受阻**:esmeralda 现有 `template_299d49bc…` 是 10-24 baseline 版(pay 3 显参),commit 5a4a974(10-26)给 pay 加了 agent_proof(当前 clients/ts 发 4 显参)→ 链报 `pay expected 4 arguments, but got 5`。需把当前 agent_budget 重发到 esmeralda(仪表盘指新地址即修好),但重发被公网 indexer 拥堵卡住(278KiB 包 40 次 submit 全 30s 超时)。细节见 `docs/esmeralda.md` "Web 仪表盘 @ esmeralda"。esmeralda 仪表盘现常驻 **:8787**(`http://localhost:8787`,连 :5100,owner=dev,Windows 可达);本地 swarm(:12010)留着但仪表盘已不依赖它。见 [[esmeralda-deploy-blocked]]。
