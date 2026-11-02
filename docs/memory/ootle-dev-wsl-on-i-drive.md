---
name: ootle-dev-wsl-on-i-drive
description: 新机器 I 盘的 WSL 发行版 ootle-dev（I:\wsl\ootle-dev）：Tari 0.47.0 二进制、本地 swarm（2026-11-02 已 init，三模板已发布，walletd :12010）、esmeralda walletd（:5100，账户 STBZ 已充值）；从 Windows 驱动 WSL 的坑与保活要求
metadata:
  node_type: memory
  type: project
  originSessionId: 4a022b8c-4142-4994-b4c5-05f3539fb6b0
  modified: 2026-11-01T14:59:51.592Z
---

**布局（I 盘，954G 空闲）**：`I:\wsl\ootle-dev`（发行版 `ootle-dev`，由空的 `Ubuntu` 导出 `I:\wsl\wslubuntu-base.tar` 再 `wsl --import`，默认 root）；`I:\wsl\downloads\`（校验过 sha256 的 `tari_ootle-0.47.0-9dabb2a-linux-x86_64.zip`、`tari_suite-6.2.0-pre.2-esme-4d7f9eb-linux-x86_64.zip`，已解压到 `extracted/`）；`I:\wsl\repo\`（`git archive HEAD` 导出的仓库受控文件，WSL 里用 `/mnt/i/wsl/repo` 再 rsync 到 `/root/ootle/...`）；`I:\wsl\setup\*.sh`（所有在 WSL 里跑的脚本）。

**WSL 内**：`/root/ootle/swarm/bin/` 七个二进制（walletd 已换成注入 `--override-keyring-password devswarm` 的 wrapper，真身 `tari_ootle_walletd.real`，0.47.0）。esmeralda walletd 启动脚本 `I:\wsl\setup\start-esme-walletd.sh`（`--network esmeralda --listen-on 127.0.0.1:5100 --authentication none -p ootle_wallet_daemon.indexer_trust=trust`，base `/root/.tari/ootle`，日志 `/root/logs/esme-walletd.out`），要用 harness 的 run_in_background 常驻；Windows 侧 `127.0.0.1:5100` 直接可达。这是**全新钱包**：account 分支 key index 0 公钥 `e6a9fae653e58619d70a2027f8865ef28c6be80e4864dd808d496c1d6d65211a`，尚无账户、无余额——旧的已充值 `dev`（2c049e88…）密钥在旧机器 WSL 里，这台机器没有（`C:\Users\39881\.tari\esmeralda` 是 3 月的旧钱包 STBZ，无关）。水龙头 `component_568f84a0…` 仍在，金库约 539000 tTARI，每次 claim 1e9 µT。**2026-11-01 已用修好的 `esme-fund`（commit 30fa227：claim→TakeFromBucket(fee)→PayFeeFromBucket→CreateAccount）充值成功**：tx `8f23a540…` Accepted，新账户名 **`STBZ`** = `component_63d78f7de802294cd9cb9b0bf67eb873abdafc982acebc62e0b6fcbeabdd8d46`，余额 999,980,000 µT；esmeralda 上 `tari publish -a STBZ` 用它。**已用它重发**：`agent_budget` = `template_88b112610740f457bcc04be70740edebc53c132885a3dda928b1c068d98db8f6`（真链确认付款验证过，验证预算 `component_dff2951f…`），`escrow` = `template_11dc03f70679e981afc5e2e48e261a74be54f87f71e35a6977313f34bbd49d09`；公网 indexer 这次不拥堵，发布各 ~30 秒。

**本地 swarm（2026-11-02 已 init）**：`I:\wsl\setup\swarm-init-start.sh`（首次 init+start；重启后 `-k` 恢复）、`swarm-check.sh`（进程/账户/epoch）、`swarm-fund.sh [name]`（accounts.create + create_free_test_coins，amount 参数被忽略固定给 1e9 µT）、`publish-local.sh <tpl…>`（PTY 包装的 `tari publish -n localnet -a default`）。walletd :12010、webui :8080；`default` 账户 `component_14c236cf…`，e2e 商户 `e2e_merchant` `component_7ce2546e…`。本机 swarm 上的模板：agent_budget `template_978113ef1251cf83cff05ca21057eefcaa2ebaa7770abf07ba82d6ffda0e453f`、escrow `template_bb8d36d251730c7e6d5a725bddf51ce43acf99ca62e7e4977e635ea3305ee3c0`、otc_board `template_5c0cd27ed0ee5867f4b960a12e33baec848c970c8b3145faf063ae3c7b8f8f28`（仓库 localnet 默认值已指向它们）。**保活**：从 Windows 用 wsl.exe 起的 setsid 进程会随发行版退出而死——必须另起一个后台 `wsl.exe -d ootle-dev -u root -- bash -c "sleep infinity"`（或任何常驻会话）把发行版撑住；esmeralda walletd 同理用 run_in_background 常驻。Windows 侧 `127.0.0.1:12010` / `:5100` 直接可达，三条 e2e 脚本都是在 Windows 上用 Y 盘的 SDK 跑的。manifest 里 TemplateAddress 参数写 `address!("template_…")` 可用（configure_escrow 验证过）。

**2026-11-02 的两个新坑**：(a) 发行版会整体被停掉（cargo test + swarm 同时跑时 WSL 自己 Stopped 了一次，原因不明，可能是后台 wsl.exe 任务被结束连带），stop 后 swarm/walletd/保活全死，要三个一起重起；(b) swarm 的锁文件在 `run/data/swarm/tari_swarm.pid`（不是 run 目录下），`swarm-init-start.sh -k` 已改为两处都清。模板源码改动后用 `sync-and-test-templates.sh`（I:\wsl\sync	emplates → /root/ootle/<tpl>，cargo test）。

**2026-11-02 晚：WSL 反复整体停机的真正原因**——不是谁下了命令，是 WSL 3.0.1.0 自己崩：事件日志里 wsl.exe 与 wslservice.exe 以 0xc00000fd（栈溢出）崩溃，随后"WSL Service 意外停止"带走整个 VM（18:45、19:55、20:00、20:04 共四次，正值三个会话并发调用 wsl.exe）。唯一可见的异常是从 Y 盘目录调用 wsl.exe 时的 `Failed to translate 'Y:\公用1\oolte'`。**规矩：所有 wsl.exe 调用先把 cwd 切到本地盘**（PowerShell `Set-Location C:\; wsl.exe -d ootle-dev …`），切到 C:\ 后那行警告消失；避免多会话并发 wsl.exe；长命令走 run_in_background。20:13 已执行 `wsl --update`：3.0.1.0 → **3.0.3.0**（内核 6.18.54），`wsl --shutdown` 后干净重启，之后观察是否还崩。排查命令：`Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000}` 看 wslservice/wsl.exe 的 1000 事件，`LogName='System'; Id=7034` 看 WSL Service 意外停止。

**从 Windows 驱动 WSL 的三个坑（都踩过）**：
1. Git Bash 调 `wsl.exe ... bash -lc '...'`：`$变量`/for 循环变量不展开，`/mnt/i/...` 还会被 MSYS 路径转换成 `D:/Program Files/Git/mnt/...`。
2. PowerShell 调 `wsl.exe ... bash -c '... | grep ...'`：引号里的管道被 PowerShell 拆开当独立命令。
3. 正解：把脚本写成文件放 `I:\wsl\setup\`，用 **PowerShell** 工具执行 `wsl.exe -d ootle-dev -u root -- bash /mnt/i/wsl/setup/x.sh`；每次都会打一行 `wsl: Failed to translate 'Y:\公用1\oolte'` 警告（工作目录是网络盘），无害。
Ubuntu apt 源在这里很慢（apt-get install 十几分钟还在 unpack）。
4. WSL 默认 NAT 解析器（172.27.x.1）在这台机器上返回 IPv6-only/空答案，`sh.rustup.rs` 不可达、curl 挂死：已在 ootle-dev 里 `generateResolvConf=false` + `/etc/resolv.conf` 固定 223.5.5.5/119.29.29.29/8.8.8.8 + `gai.conf` 优先 IPv4（脚本 `fix-dns-and-rustup.sh`）。Rust 1.99.1 从 Windows 下载的 `rustup-init` 装的（校验过 sha256），wasm32 目标已装。
5. 用 Windows 上的 Python 改写要在 WSL 里跑的 `.sh` 时会写成 CRLF（`set: -: invalid option`、`$'{
'` 语法错）：用 `newline="
"` 写，或事后 `sed -i 's/
$//'`。`tari publish` 的费用估算偶尔差几十 µT（`Insufficient fees paid`），`publish-esme.sh <tpl> <attempts> <max_fee>` 第三个参数透传 `--max-fee`。

**Why:** 下次会话直接复用这套环境，不用重搭；esmeralda 重发需要先充值一个账户（走 `scripts/esme-fund` 水龙头路径，或拿到旧机器导出的 `dev` 密钥）。
**How to apply:** 查看状态 `bash /mnt/i/wsl/setup/status.sh`；装 CLI + 同步模板 `install-cli-and-sync.sh`；构建充值助手 `build-esme-fund.sh`；充值 `PUBKEY=e6a9… python3 /mnt/i/wsl/setup/esme_fund_submit.py [--submit]`。见 [[machine-y-drive-env]] [[local-swarm-devnet]] [[esmeralda-deploy-blocked]]。
