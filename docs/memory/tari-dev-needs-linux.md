---
name: tari-dev-needs-linux
description: "Tari Ootle template dev (tests + CLI) must run on Linux/WSL, not native Windows"
metadata:
  node_type: memory
  type: project
  originSessionId: 30883ce1-2799-45ad-b5e4-1944cba09e7d
  modified: 2026-10-21T06:50:25.535Z
---

Ootle/Tari WASM 模板开发在原生 Windows 上跑不了，必须用 Linux（本机已装 WSL2+Ubuntu）。已实证的两处硬阻塞：

- **模板测试**：`tari_template_test_tooling` → `tari_engine` 对 `wasmer` 写死 `features=["cranelift"]`（还用 fork 的 `tari-wasmer-middlewares`，metering/缓存都是 Cranelift 专用），而 `wasmer-compiler-cranelift` 在 Windows 直接 `compile_error!("not supported on Windows")`。不是改一行能换后端的。
- **CLI**：`cargo install tari-ootle-cli`（crates.io 实为 0.33.0，非 docs.rs 显示的 0.10.0）依赖 `openssl-sys`（需 OpenSSL dev）+ `wasm-opt-sys`（内置 binaryen，MSVC 编译失败）。

官方 CI（`tari-project/wasm-template/.github/workflows/ci.yml`）只用 `ubuntu-latest`，印证面向 Linux。

**How to apply（已搭好的环境，直接用）**：
- WSL 发行版：`Ubuntu-24.04`（WSL2）。以 root 跑命令，无需 OOBE：
  `wsl.exe -d Ubuntu-24.04 -u root -- bash -lc '. "$HOME/.cargo/env"; <cmd>'`
- Ubuntu 内已装：Rust 1.99.1 + wasm32-unknown-unknown + build-essential/cmake/clang/libssl-dev + tari-ootle-cli 0.33.0（`/root/.cargo/bin/tari`）。
- 仓库在 WSL ext4：`/root/ootle/wasm-template`（**不要在 /mnt/f 上编译**，9p 慢且易卡）。源码从 Windows 的 `F:\oolte\wasm-template` 复制而来（WSL2 NAT 网络对 git 大包会超时，crates.io 分包下载正常）。
- Phase 0 实测通过：guessing_game `cargo test` → `test it_works ... ok`；`cargo build --target wasm32-unknown-unknown --release` 产出 150K `guessing_game.wasm`。
- 还没做：真正的 `tari publish` 上链（需 Tari Wallet Daemon + devnet 连接/测试资金，暂无）。
- Windows 侧也装了 Rust 1.99.1 + wasm32 + VS2022/MSVC + OpenSSL-Win64，但只能做 clippy/wasm 构建，跑不了测试和 CLI。
- `tari --skill` 可生成 CLI 用法指南，适合做 Phase 1 的 API 参考。CLI 真实子命令：init/create/build/lint/publish/template/metadata/config。
