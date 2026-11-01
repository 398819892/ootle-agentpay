---
name: machine-y-drive-env
description: 2026-11-01 起 Ootle AgentPay 仓库在新机器的 Y:\公用1\oolte（RaiDrive WebDAV 网络盘）；git 需 safe.directory；网络盘上 npm install 会损坏 node_modules（TS 要在本地盘构建）；本机 WSL 是全新空环境
metadata:
  node_type: memory
  type: project
  originSessionId: 4a022b8c-4142-4994-b4c5-05f3539fb6b0
  modified: 2026-11-01T14:43:06.003Z
---

**仓库位置变了**：从旧机器的 `F:\oolte`（用户 cam）搬到新机器 `Y:\公用1\oolte`（用户 39881，内存目录 `C:\Users\39881\.claude\projects\Y----1-oolte\memory\`）。`Y:` 是 **RaiDrive 的 WebDAV 挂载**（UNC `//RaiDrive-1/WebDAV (1)/公用1/oolte`），git 会报 "dubious ownership"——已在全局 git config 加了两条 `safe.directory`（UNC 形式和 `Y:/公用1/oolte`）。WSL 无法翻译 `Y:` 路径（`wsl: Failed to translate`），所以 WSL 里**不能**直接 `cd` 到这个仓库；要在 WSL 用需先 copy 到 ext4。

**网络盘上不要 `npm install` / `tsc`**：在 `Y:` 的 `clients/ts` 里 `npm install` 后 tsc 报 `node_modules/undici-types/*.d.ts` 语法错误（文件被读花，和旧机器 /mnt 9p 同款问题），而且 tsc 会先把 `dist/` 写坏一部分。正确做法：把 `clients/ts/src` + `package.json` + `tsconfig.json` 拷到本地盘临时目录（本会话用 scratchpad 的 `ts-build/`），那里 `npm install && npm test`，再把 `dist/*.js` + `*.d.ts`（排除 `*.test.*`）拷回仓库。新 tsc 产出的 `window.js`/`api.d.ts` 和旧提交有良性差异（exports 写法、少一行 reference），不是 bug。

**本机工具（2026-11-01 实测）**：
- Windows 侧：node v24.14.1 / npm 11、Python 3.12.3（pytest + pytest-asyncio 已 `pip install --user`）、cargo/rustc 1.96、git 2.53（user.name=cam）。
- WSL `Ubuntu`（24.04，发行版名就叫 `Ubuntu`，不是旧机器的 `Ubuntu-24.04`）：**空的**——只有 python3 3.12 和 rsync；`/root/ootle` 不存在，没有 cargo、tari CLI、node、swarm 二进制、walletd。模板 `cargo test`、`make ci`、本地 swarm 都要先按 HANDOFF §2 重搭（或 `wsl --import` 旧机器导出）。
- SDK pytest（69 passed, 排除 test_keys）、web 六个 node 套件（22/9/10/15/3/7）、clients/ts `npm test`（11）都能在 **Windows 原生**跑通，不需要 WSL。

**Why:** 换机器后旧记忆里的路径（F:\oolte、/root/ootle、Ubuntu-24.04）都失效；验证改动时要知道哪些套件本机能跑（Python/Node 可以，Rust 模板不行），以及 TS 构建必须离开网络盘。
**How to apply:** 改模板代码前先搭 WSL 工具链或信 GitHub CI（push 后看 6 个 job）；Python/Node 改动直接在 Windows 验证；TS 改动按上面的本地目录流程重建 dist 并一起提交。见 [[tari-dev-needs-linux]] [[local-swarm-devnet]] [[ts-client-phase6]]。
