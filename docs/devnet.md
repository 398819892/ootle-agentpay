# Local devnet (swarm) setup / 本地开发网搭建

The Tari Ootle dev tooling is Linux-only (the engine's wasmer **cranelift** backend doesn't build on
Windows). This project was developed on **WSL Ubuntu 24.04**. A local "swarm" runs the whole stack
(base node, console wallet, validator node, indexer, wallet daemon) from **prebuilt binaries — no
source build needed**.

## 1. Binaries

Download, into one folder (e.g. `/root/ootle/swarm/bin`):

- From `tari-project/tari-ootle` release **v0.47.0** (the L2, one zip): `tari_swarm_daemon`,
  `tari_validator_node`, `tari_indexer`, `tari_ootle_walletd`.
- From `tari-project/tari` release **v6.2.0-pre.2**, the **esme** suite (NOT mainnet — mainnet
  binaries reject `localnet`): `minotari_node`, `minotari_console_wallet`, `minotari_miner`.

> Version match matters: tari-ootle v0.47.0 pins L1 (minotari) crates at **6.2.0-pre.2**. A mismatched
> L1 fails validator-node registration with "Invalid validator node signature".

## 2. WSL has no OS keyring

`tari_ootle_walletd` wants the OS keyring for wallet encryption; WSL has none. Replace the binary with
a wrapper that injects a password, so the swarm's walletd children work:

```bash
mv tari_ootle_walletd tari_ootle_walletd.real
cat > tari_ootle_walletd <<'EOF'
#!/bin/bash
exec "$(dirname "$0")/tari_ootle_walletd.real" --override-keyring-password devswarm "$@"
EOF
chmod +x tari_ootle_walletd tari_ootle_walletd.real
```

## 3. Init & start

```bash
cd /root/ootle/swarm/run
../bin/tari_swarm_daemon -c ./config.toml init  --no-compile --binaries-root ../bin --wallet-daemon-auth none --force
../bin/tari_swarm_daemon -c ./config.toml start --no-compile --binaries-root ../bin --wallet-daemon-auth none
# after a reboot, resume with `start -k` (keeps the registered validator); rm a stale run/tari_swarm.pid if needed
```

The swarm mines L1 funds, registers the validator, and serves: web UI `http://localhost:8080`,
**wallet daemon JSON-RPC `http://127.0.0.1:12010`**.

## 4. Fund an account and publish

`--wallet-daemon-auth none` still requires a bearer token; mint one with no credentials:

```bash
# token
curl -s localhost:12010/json_rpc -d '{"jsonrpc":"2.0","id":1,"method":"auth.request","params":{"permissions":["Admin"],"duration":null,"credentials":"None"}}'
# fund the default account (localnet faucet works; public esmeralda faucet is empty)
#   accounts.create_free_test_coins {account:{Name:"default"}, amount:1000000, max_fee:50000}
# publish a template (needs a pseudo-tty: wrap in `script -qec "…" /dev/null`)
TARI_WALLET_DAEMON_API_KEY=<token> tari -n localnet publish -a default -y --wallet-daemon-url http://127.0.0.1:12010/json_rpc
```

## 5. Call a template on chain

Submit a transaction **manifest** via `transactions.submit_manifest`
(`{manifest, variables, max_fee, dry_run}`); `dry_run:true` validates and returns the validator's
reject reason, `dry_run:false` commits (poll `transactions.get_result`). Manifest notes:

- `use template_<hash> as Name;` then `Name::func(...)`; call an existing component via `var!["x"]`.
- `variables` values are plain strings (`{"x":"component_…"}`).
- `amount!(N)` (not `Amount(N)`), `address!("component_…")`, `public_key!("<64hex>")`,
  `hex_bytes!("<64hex>")` for a `Hash32`, `None`, lists `[…]`, tuple-destructure `let (a,b)=…`.
- Badge-gated calls: `let p = acct.create_proof_for_resource(address!("resource_…")); … ; drop_all_proofs!();`.
- The wallet daemon pays the fee from, and signs with, the referenced default account.

Helper scripts live in `ootle-bin/`: `call-escrow.py`, `otc_demo.py`, and the agentpay demos
(`examples/demo_devnet.py`, `stress_devnet.py`).

## Public testnet (esmeralda)

Same flow with `tari_ootle_walletd --network esme` and `tari -n esmeralda`, **but** the public faucet
was empty during development; `tTARI` must be obtained by burning L1 Minotari and claiming it
(walletd "Claim Burn"). Account creation / API keys use the walletd web UI at `http://localhost:5100`
(WebAuthn). Deploy there once funds are available.
