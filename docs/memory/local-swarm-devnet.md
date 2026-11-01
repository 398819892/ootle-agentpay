---
name: local-swarm-devnet
description: 本地 Tari swarm 私链（已跑通真实 tari publish 上链）的可复现配方
metadata:
  node_type: memory
  type: project
  originSessionId: 30883ce1-2799-45ad-b5e4-1944cba09e7d
  modified: 2026-10-22T00:21:19.141Z
---

在 WSL Ubuntu 里用**预编译二进制**跑本地 Tari swarm 私链，已端到端跑通 `tari publish` 上链（guessing_game 模板地址 `template_458a0933b2f6f7c68dda941b488e7ca2ae411d5af705d4adfa07f3be2eb7e8ff`）。无需源码编译。见 [[tari-dev-needs-linux]]。

**踩过的关键坑（都已解决）：**
- **L1/L2 版本必须匹配**：L2（tari-ootle）用 v0.47.0；它 Cargo.toml pin 的 L1（minotari）是 **6.2.0-pre.2**，不是 README 写的 v5.2.0-pre.5。版本不符 → VN 注册 "Invalid validator node signature" 崩溃。
- **L1 二进制要 esme 版，不要 mainnet 版**：mainnet 版拒绝 localnet（"network localnet is invalid for this binary built for MainNet"）。
- **WSL 无 OS keyring**：walletd 需 `--override-keyring-password`，但 swarm 不给子进程传。解法：把 `tari_ootle_walletd` 换成 wrapper 脚本自动追加该参数（原二进制存为 `tari_ootle_walletd.real`）。
- **JSON-RPC 认证**：即使 `--wallet-daemon-auth none`，walletd 仍要 bearer token。none 模式下免 WebAuthn 铸 token：POST auth.request，params `{"permissions":["Admin"],"duration":null,"credentials":"None"}` → 直接返回 Admin JWT（credentials 合法值只有 `None` 或 `WebAuthN`）。
- **领币**：localnet 的 `accounts.create_free_test_coins` 能用（esmeralda 公共网 faucet 是空的，只能 L1 烧币）。要先 `accounts.create` 建账户，max_fee 给够（≥50000）。
- **publish 需 PTY**：`tari publish` 没 TTY 会报 "IO error: not a terminal"，用 `script -qec "..." /dev/null` 包一层。

**文件位置（WSL ext4）：**
- 二进制：`/root/ootle/swarm/bin/`（6 个：minotari_node/console_wallet/miner 来自 tari v6.2.0-pre.2 esme suite；tari_validator_node/tari_indexer/tari_ootle_walletd 来自 tari-ootle v0.47.0 的 tari_ootle-linux-x86_64.zip）
- swarm 工作目录：`/root/ootle/swarm/run`（config.toml + data）
- 辅助脚本（Windows 侧 `F:\oolte\ootle-bin\`）：setup-account.sh、fund3.sh、publish.sh、verify.sh、walletd-wrapper.sh

**启动命令：**
`cd /root/ootle/swarm/run && ../bin/tari_swarm_daemon -c ./config.toml start --no-compile --binaries-root /root/ootle/swarm/bin --wallet-daemon-auth none`
（首次要 init；swarm 挖矿产 L1 币、自动注册 VN。webui :8080，swarm walletd JSON-RPC 在 **127.0.0.1:12010**。）

**端口**：minotari_node 12000-12002；console_wallet 12004；validator 12005-12007；indexer 12008-12009；**walletd 12010**。

**重启（WSL/Windows 重启后）**：`start -k`（跳过重新注册，恢复链状态；账户/资金/已发布模板都在）。若报 lockfile 已存在，先 `rm -f /root/ootle/swarm/run/tari_swarm.pid`。

**链上调用模板（不止发布，实测可用）**：walletd JSON-RPC `transactions.submit_manifest`，最小参数 `{manifest, variables, max_fee, dry_run}`。manifest 是 DSL：
```
use template_<hash> as Name;
fn main() {
    let mut acct = var!["payer"];
    let funds = acct.withdraw(XTR, amount!(1000));   // 是 amount!(),不是 Amount()
    Name::func(funds, address!("component_.."), public_key!("<hex>"), None, 10u64, 500u64);
}
```
- `variables` 值是**纯字符串**（如 `{"payer":"component_.."}`），不是 map。
- Option::None 写 `None`；地址 `address!("component_..")`；公钥 `public_key!("<64hex>")`；Amount 用 `amount!(N)`；u64 用 `10u64`。
- `dry_run:true` 先模拟验证（返回 required_fees + 会创建的组件）；`dry_run:false` 真提交返回 tx_id，再轮询 `transactions.get_result{transaction_id}` 直到结果含 Accept/Reject。
- 手续费自动从被引用账户（default）的 vault 扣，walletd 用该账户的 key 签名 → 模板里 `CallerContext` = 该账户公钥。
- 领币前新账户要先 `accounts.create` 再 `create_free_test_coins`（确认上链）。脚本见 `F:\oolte\ootle-bin\call-escrow.py`（实例化+release+余额校验）。

**已验证**：Escrow 模板发布地址 `template_9b230fab92bd2c2e32b82d28162854b9d31a2cb6a950a7920088cb8d54f2ef90`；链上实例化+release 成功，payee +950 / treasury +50（1000 资金 5% 费），真实验证节点共识确认。
