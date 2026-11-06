# VPS 部署步骤：esmeralda testnet，给别人测试

> 目标拓扑：一台 VPS（你选的 **vc2-2c-4gb**，2vCPU/4GB/80GB，够用）上跑
> **反向代理(Caddy, TLS) → dashboard:8787 → walletd:5100**，再可选加一个
> **MCP server(:8000/mcp)** 给 AI agent 远程接入。全部指向 **esmeralda 公共测试网**，
> 钱包里只有 tTARI（水龙头测试币，无价值）。
>
> 权威细节见仓库里已有的 [`web/DEPLOYMENT.md`](../web/DEPLOYMENT.md)（dashboard）、
> [`docs/remote-mcp.md`](remote-mcp.md)（MCP）、[`docs/esmeralda.md`](esmeralda.md)（链上地址/充值）。
> 本文是把它们串成「你这台 VPS + 给别人测」的一条顺序清单，并**如实标出真正的卡点**。

---

## 0. 先认清两个「真·前提」（成败就在这里，其余都是例行公事）

这两件事没搞定，`docker compose up` 跑起来也付不了款——务必先处理：

### 前提 A：一个「已充值的 esmeralda 账户」的 keyring

dashboard/MCP 自己不持钥匙，**walletd 才持钥匙并签名**。walletd 要能付款，必须有一个
**已经在链上、且有 tTARI 余额**的账户。你现在这样的账户是 `STBZ`
（`component_63d78f7d…`，见 [`docs/esmeralda.md`](esmeralda.md)），但它的**私钥/keyring 只在你本地的 WSL**（`I:\wsl`）里。

两条路，**强烈建议走第 1 条**：

1. **把本地那个已充值账户的 keyring + esmeralda config 打包搬到 VPS**（省去在 VPS 上重新充值的所有麻烦）。
   需要搬的是 walletd 的数据目录（通常 `~/.tari/ootle/esmeralda/`，含 keyring 和 config），
   以及解锁用的 keyring 口令。搬过去后 VPS 上的 walletd 直接就是那个 `STBZ` 账户。
2. **在 VPS 上新建账户并充值**：esmeralda 公共 faucet 的充值 **manifest DSL 表达不了**
   （要在一笔交易里 `claim → 付费 → 建账户`），得用仓库里的 Rust 构造器
   `scripts/esme-fund/` + `scripts/esme_fund_submit.py`。能做，但繁琐，还要在 VPS 上装 Rust。
   除非你不想碰本地 keyring，否则别走这条。

> 安全上：testnet 阶段 keyring 放 VPS 可以接受（丢的只是测试币）。等**接真实资金**那天，
> 钥匙就不能放对外 VPS 了——那是另一套方案（独立签名服务，见 [`docs/custody.md`](custody.md)）。

### 前提 B：先核对 esmeralda 的「网络版本」和「模板地址」还有效

仓库 `node-binaries/bins/tari_ootle_walletd` 是 **0.47.0**；而 README 记录 **upstream 在
2026-11-02 升到 0.49.x，esmeralda 做过两次 reset**。testnet 一 reset，旧的模板地址/账户可能作废。
所以动手前，先用这个 walletd 连一下 esmeralda，确认三件事：

- 这个 0.47 walletd **还能连上**当前 esmeralda（连不上就得换与当前网络配套的 walletd 二进制）；
- 你要用的 **AgentBudget 模板** `template_88b112610740f457bcc04be70740edebc53c132885a3dda928b1c068d98db8f6`
  **还在链上**（`substates.get` 查一下）；
- 你的**账户**在链上且**有余额**。

> 如果模板已被 reset 清掉，就得从 `templates/agent_budget` 重新发布一份。注意：**发布是大交易
> （WASM ~245KiB），公网 esmeralda indexer 经常 30s 超时**（见 esmeralda.md 的多次记录）——这是
> 整个流程里唯一真正难受的一步。**付款/开预算这种小交易不受影响，能过**。所以尽量复用现成模板地址，
> 别到部署时才发现要重发。

---

## 1. VPS 基础准备

```bash
# Ubuntu VPS 上
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER && newgrp docker      # 让当前用户能用 docker

# 防火墙：只放 80/443（给 Caddy）和 SSH；walletd:5100、dashboard:8787 都不对外
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

- 给域名加一条 **A 记录**（如 `pay.example.com`）指向 VPS 的公网 IP（Caddy 签证书要用）。
- `git clone` 本仓库到 VPS。

## 2. walletd（持钥匙的那层，最关键）

把 0.47 walletd 二进制和你的 esmeralda 配置/keyring 放到位：

```bash
# 二进制（仓库里已带，x86-64 Linux）
mkdir -p web/walletd
cp node-binaries/bins/tari_ootle_walletd web/walletd/
chmod +x web/walletd/tari_ootle_walletd

# esmeralda 配置：关键一行——indexer_trust = "trust"
#   在 ~/.tari/ootle/esmeralda/config/config.toml 的 [ootle_wallet_daemon] 段设：
#     indexer_trust = "trust"
#   （公共 indexer 无法在 walletd 硬编码的 30s 内完成 validator-set proof 验证；
#    这是 dev-only 放宽，交易仍由 esmeralda 真·验证节点执行。）
```

- keyring 口令通过环境变量 `TARI_WALLET_DAEMON_KEYRING_PASSPHRASE` 传入，**绝不写进镜像或日志**。
- 两种跑法（都保持 walletd **不对外暴露端口**）：
  - **compose sidecar**：用 `web/docker-compose.yml` 里现成的 `walletd` 服务（无 `ports:`，只在私有网可达）。把二进制和 `~/.tari` 用 volume 挂进去。
  - **跑在宿主机**（常更简单）：`systemd` 起 walletd 绑 `127.0.0.1:5100`，删掉 compose 里的 `walletd` 服务，dashboard 指向 `http://host.docker.internal:5100/json_rpc`。
- 先验证前提 B：`auth.request` 拿 token → `substates.get{当前模板地址}` → 查账户余额，三样都 OK 再往下。

## 3. dashboard（浏览器 UI，给人用）

```bash
# 从仓库根构建镜像（zero-dependency，无需 npm install）
docker build -f web/Dockerfile -t agentpay-dashboard .

# 配置密钥
cp web/.env.example web/.env
#   在 web/.env 里填：
#   DASHBOARD_PASSWORD        = 一个长随机口令（登录用）
#   SESSION_SECRET            = openssl rand -hex 32
#   AGENTPAY_ADMIN_PASSWORD   = 另一个、与上面不同的长随机口令（提现/撤销等高危操作的二次确认）
#   WALLETD_KEYRING_PASSWORD  = 你 walletd keyring 的口令
#   AGENTPAY_BUDGET_TEMPLATE  = template_88b11261…（前提 B 验证过的那个）
#   AGENTPAY_OWNER_ACCOUNT    = STBZ（或你充值的账户名）
#   AGENTPAY_ALLOWED_HOSTS    = pay.example.com
#   AGENTPAY_AUTO_CREATE_MERCHANTS=false   # 公网部署别让它按需建/充商户账户

docker compose -f web/docker-compose.yml up -d     # dashboard 只绑 127.0.0.1:8787
```

> 镜像里 `HOST=0.0.0.0`，服务会把自己当「网络暴露」，因此**不设 `AGENTPAY_ADMIN_PASSWORD`（且与登录口令不同）就拒绝启动**——这是刻意的硬要求。

## 4. 反向代理 + TLS（Caddy，自动签证书）

宿主机装 Caddy，`Caddyfile`：

```
pay.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 自动申请/续期 Let's Encrypt 证书，并带上 `X-Forwarded-Proto: https`，dashboard 随即签发 `Secure` cookie。
（nginx + certbot 等价：`:443` → `127.0.0.1:8787`，转发 `X-Forwarded-Proto`。）
别忘了在 `web/.env` 里按需设 `TRUSTED_PROXY=true`，否则限流看到的都是代理 IP。

## 5.（可选）MCP server：给 AI agent 远程接入

如果「别人测试」是指别的 AI（Claude 连接器 / ChatGPT 自定义连接器 / 脚本 agent）调工具付款，再在这台 VPS 上加一个 MCP：

```bash
pip install 'agentpay-mcp[http]'
# 连同一个 walletd、同一个模板/账户；每个测试者发一把独立 token（逗号分隔，可单独撤销）
AGENTPAY_WALLETD_URL=http://127.0.0.1:5100/json_rpc \
AGENTPAY_BUDGET_TEMPLATE=template_88b11261… \
AGENTPAY_OWNER_ACCOUNT=STBZ \
AGENTPAY_MCP_HTTP_TOKEN="tokA,tokB,tokC" \
  agentpay-mcp --http --http-host 127.0.0.1 --http-port 8000
```

在 Caddy 里再加一段把 `/mcp` 反代到 `127.0.0.1:8000`（或用单独子域名）。客户端填
`https://你的域名/mcp` + `Authorization: Bearer <那把 token>`。`agentpay-mcp --emit-config --host remote` 会打印现成的接入信息。

> 另一条给「程序/第三方」用的通道是 dashboard 自带的 **/api/v1 REST**（`AGENTPAY_API_KEYS=agent:bot1:sk_…`），和 MCP 是两个面，按需开一个即可。

## 6. 给别人测试：发 token、设上限、隔离

- **链上上限是硬边界**：即便 token 泄露，对方也只能在**单笔 / 每日上限内、对白名单商户**付款，你可随时 `revoke`。把上限设到「被滥用也可接受」。
- **每个测试者一把 token**（MCP 的 `AGENTPAY_MCP_HTTP_TOKEN` 逗号分隔；或 /api/v1 一人一把 key）——撤销就删掉那把、重启。
- **额度隔离**：多人共用一个 budget 会互相消耗额度（testnet 无所谓，花光再从水龙头领）；要隔离就给每人单独的 agent/budget。

## 7. 验证

```bash
curl -s https://pay.example.com/api/session        # {"authRequired":true,"authed":false}
curl -s -o /dev/null -w '%{http_code}\n' https://pay.example.com/api/state   # 401（未登录打不开）
# 登录后开预算、付款、故意超额，应看到 esmeralda 验证节点给的拒绝理由
```

MCP：用任意远程 MCP 客户端连 `https://你的域名/mcp` + 正确 token，`list_merchants` 应返回商户。

## 8. 安全清单（照 web/DEPLOYMENT.md §8 过一遍）

- [ ] `DASHBOARD_PASSWORD` / `SESSION_SECRET` / `AGENTPAY_ADMIN_PASSWORD`(与登录口令不同) 都已设。
- [ ] `walletd:5100` **无任何对外端口映射**（`docker compose ps` / `ss -tlnp` 确认只在 127.0.0.1 或私有网）。
- [ ] keyring 口令只来自环境变量，不在镜像/compose/日志里；`web/.env` 已被 git 忽略。
- [ ] 全程 HTTPS，`COOKIE_SECURE=true`；`TRUSTED_PROXY` 已设。
- [ ] walletd 机器上**只有这个测试账户的钥匙**，且只放你愿意暴露的测试币。
- [ ] 反代只转 `:443` → dashboard；没有任何东西转发到 walletd。
- [ ] 记住定位：**这是托管式 testnet 演示，后端被攻破可提走整个（测试）金库；不要托管真实/主网资金。**

---

## 资源够不够？

vc2-2c-4gb（2vCPU/4GB/80GB/3TB）对 **dashboard + MCP + walletd** 绰绰有余——这些都是轻服务，内存合计通常几百 MB，磁盘几乎用不到，3TB 流量对小 JSON API 是海量。**唯一会吃满机器的是在本机自建 local swarm**（validator+indexer+walletd 整套），但那是开发用，对外部署不需要——你连的是 esmeralda 现成的网络，**不用自己跑验证者节点**。
