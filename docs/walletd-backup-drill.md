# walletd 备份与恢复演练（主网 P0 #5）

> 演练日期 2026-11-02，对象：本机 `ootle-dev` WSL 里的 esmeralda walletd（0.47.0，base path `/root/.tari/ootle`）。
> 主网上线前要在**官方主网版本**的 walletd 上按同样步骤再做一次。脚本：`I:\wsl\setup\walletd-drill.sh`。

## walletd 在磁盘上有什么

| 文件 | 作用 |
|---|---|
| `<base>/<network>/data/wallet.sqlite` | **钱包全部状态**：密钥（用 keyring 口令加密）、账户、交易记录。这就是资金。 |
| `<base>/<network>/config/config.toml` | 配置（indexer、trust、端口等） |
| `<base>/<network>/pid` | 锁文件，恢复时删掉 |
| keyring 口令 | 不在磁盘里：OS keyring，或 `--override-keyring-password` 给的值。**没有口令，sqlite 打不开。** |

所以备份 = `wallet.sqlite` + `config.toml` + **口令**（口令单独保管，不和归档放在一起）。

## 两条恢复路径

1. **文件级恢复**（本次演练）：把归档解到一个新的 base path，用同一个口令启动，账户、地址、余额立即可用。
2. **助记词恢复**：`tari_ootle_walletd --network <net> --base-path <base> --override-keyring-password <pw> seed-words`
   打印助记词；`--seed-words "<words>"` 启动一个空 base path 即可重建密钥（账户需要链上重新扫描）。
   **助记词只能 owner 本人在终端里导出并离线保管**，不要进任何脚本、日志、聊天记录或代码仓库；
   本次演练刻意没有做这一步。

## 本次演练结果

```
1. pkill walletd → tar -czf /root/backup/esme-ootle-20261102-195939.tar.gz -C /root/.tari ootle   (1.9 MB)
2. tar -xzf … -C /root/restore-test/file ; rm pid ; 用同一口令在 :5101 启动
   accounts.list  → STBZ component_63d78f7de802294cd9cb9b0bf67eb873abdafc982acebc62e0b6fcbeabdd8d46 （与生产一致）
   get_balances   → tTARI 994443508 + OWNER/AGENT badge（从链上 refresh 读到）
   FILE RESTORE: PASS
3. 删除恢复目录，重启 :5100 生产 walletd
```

## 主网 Day-0 的备份规程（由此演练得出）

- **创建 owner 账户后、burn 之前**：停 walletd → tar base path → 记录 sha256 → 解到临时目录用第二个端口启动验证 `accounts.list` → 删除临时目录。归档至少两份离线介质；口令另存。
- **每次发布模板 / 改预算规则后**：同样再备一次（sqlite 里有交易记录和新的 key index）。
- **恢复演练不通过，不上主网。**
- 归档本身是加密的 sqlite，但不要当成"安全的"：拿到归档 + 口令 = 拿到资金。归档和口令分开存放。
- walletd 数据目录所在主机只放愿意暴露的金额；预算本金用 `top_up` 按需补。