# 远程 MCP(Streamable HTTP):让手机 / ChatGPT / 远程客户端接入

AgentPay 的 MCP server 默认走 **STDIO**——本地客户端(Claude Desktop、Cursor)直接把它当子进程启动,
这也是最安全的默认。但手机上的 Claude、ChatGPT 的自定义连接器等**远程客户端**没法启动本地进程,
它们走的是**远程 HTTPS MCP**。好消息:**同一个 server** 自带 **Streamable HTTP** 传输,不用另写一套。

```
                     agentpay-mcp(一套工具与业务逻辑)
                                │
                 ┌──────────────┴──────────────┐
              STDIO(默认)            Streamable HTTP(可选)
           本地:Claude Desktop         远程:手机 Claude / ChatGPT
                   / Cursor            经 HTTPS 反向代理接入
                                │
                     AgentBudget / AgentPay(Tari Ootle 链上强制上限)
```

> 这条传输**不会**放大客户端能做的事,只改变"怎么连"。单笔 / 每日上限、商户白名单、随时撤销,
> 以及付款的人工确认,仍然是真正的边界(见 [`securing-the-mcp-agent.md`](securing-the-mcp-agent.md))。

## 1. 本地快速试

```bash
pip install 'agentpay-mcp[http]'          # http 传输需要 uvicorn
agentpay-mcp --http                        # 监听 http://127.0.0.1:8000/mcp,环回地址、本地免鉴权
```

绑定在 `127.0.0.1` 时可免 token(仅本机可达)。这时就是一个标准的 Streamable HTTP MCP 端点,
可用任何支持远程 MCP 的客户端在本机联调。

## 2. 鉴权(bearer token)

一旦要让**本机之外**访问,就必须带 token——这是硬性的,`fail-closed`:

- 设 `AGENTPAY_MCP_HTTP_TOKEN`,客户端每个请求都要带 `Authorization: Bearer <token>`,否则 `401`。
- **不设 token 却绑非环回地址(如 `0.0.0.0`)会被直接拒绝启动**,防止把支付端点裸奔到网络上。
- token 在服务器端**常量时间比较**,不记日志、不回显;`get_server_info` 只报告"是否开启鉴权",从不暴露 token 本身。

```bash
# 生成一个强随机 token 并启动(仍绑 127.0.0.1,由反向代理对外):
AGENTPAY_MCP_HTTP_TOKEN=$(openssl rand -hex 32) \
  agentpay-mcp --http --http-host 127.0.0.1 --http-port 8000
```

**每个 Agent 一把 key / 撤销 / 轮换:** `AGENTPAY_MCP_HTTP_TOKEN` 支持逗号分隔的多把 token,
给不同 Agent 各发一把;撤销某把就从列表里删掉它再重启;轮换就是加新的、停用旧的。

## 3. 对外部署:HTTPS 反向代理

**不要**直接把 `--http-host 0.0.0.0` 暴露到公网。标准做法是把 server 绑在 `127.0.0.1`,
由反向代理(Caddy / nginx)终止 TLS 再转发。

Caddy(最简,自动签证书):

```
mcp.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

nginx(片段):

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8000/mcp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";          # Streamable HTTP 需要长连接 / 流式响应
    proxy_buffering off;
}
```

拿到可粘贴的连接信息:

```bash
agentpay-mcp --emit-config --host remote
# 打印本地端点、启动命令,以及客户端该用的:
#   URL:    https://YOUR_DOMAIN/mcp
#   Header: Authorization: Bearer <AGENTPAY_MCP_HTTP_TOKEN>
```

## 4. 接入各客户端

| 客户端 | 怎么接 | 备注 |
|---|---|---|
| Claude(网页 / 手机) | 在 claude.ai 添加「自定义连接器 / Custom connector」,填 `https://你的域名/mcp` 和 Bearer header | 手机端连的是你部署的远程服务,不是本地 |
| ChatGPT(自定义连接器) | 开发者 / 连接器设置里添加远程 MCP,填同样的 URL 和鉴权 | 需远程 HTTPS,官方目前自定义连接器以网页端为主 |
| Claude Desktop / Cursor | 仍建议用 **STDIO**(`--install --host claude/cursor`),本地更简单安全 | 也能连远程,但本地无需暴露网络 |

> 各平台对远程 MCP 的鉴权方式、写入权限、交互体验支持不一,接入后要**逐个实测**,别假设都一样。

## 5. 安全清单(涉及真实资金,务必过一遍)

- **钱包钥匙永远不要放在对外的机器上。** 远程 server 应当是 `attach` 非托管模式——只持 agent 徽章、最小权限的 walletd token(见 [`deployment-noncustodial.md`](deployment-noncustodial.md) / [`securing-the-mcp-agent.md`](securing-the-mcp-agent.md))。
- **强制 HTTPS**,token 只走加密通道;生产环境别用自签或明文 HTTP 对外。
- **每个 Agent 独立 token**,支持撤销 / 轮换;token 泄露即删除并重启。
- **链上上限是硬边界**:即便 token 泄露,攻击者也只能在单笔 / 每日上限内、且仅对白名单商户付款,owner 可随时 `revoke`。把上限设到"即使被滥用也可接受"的量级。
- **逐笔确认**:远程 / 无人值守场景下,客户端未必能弹出人工确认。要么把上限压到很小靠链上边界,要么用控制台的"额外口令"(支持 elicitation 的客户端)或 owner 侧的人工批准流程。
- **`/api/v1` 不是 MCP**:控制台那套带 API Key 的 REST 接口是另一个面,别把它当成 MCP 端点对外。

## 6. 和 STDIO 的关系

STDIO 一点没变,仍是默认,本地客户端照旧。HTTP 是**纯增量**:同一套工具、同一套链上强制逻辑,
只是多了一种连接方式。你维护一套业务代码,就能同时服务本地和远程/移动端。
