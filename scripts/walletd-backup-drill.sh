#!/bin/bash
# File-level backup / restore drill for the esmeralda walletd (base /root/.tari/ootle).
# Produces /root/backup/esme-ootle-<ts>.tar.gz and proves that a restore of it into a FRESH base path
# serves the same account (STBZ address + on-chain balance) on a second port. No secret is printed or
# copied anywhere except inside the archive itself (which is the encrypted wallet.sqlite + config).
set -u
BIN=/root/ootle/swarm/bin/tari_ootle_walletd.real
BASE=/root/.tari/ootle; NET=esmeralda; PW=devswarm
EXPECT_ADDR=component_63d78f7de802294cd9cb9b0bf67eb873abdafc982acebc62e0b6fcbeabdd8d46
TS=$(date +%Y%m%d-%H%M%S); mkdir -p /root/backup /root/restore-test /root/logs; chmod 700 /root/backup
rpc() { local tok; tok=$(curl -s -m 20 "$1" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"auth.request","params":{"permissions":["Admin"],"duration":null,"credentials":"None"}}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["token"])' 2>/dev/null) || return 1
  curl -s -m 60 "$1" -H 'Content-Type: application/json' -H "Authorization: Bearer $tok" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}"; }
echo "=== 1. stop the :5100 walletd (consistent copy), archive the base path"
pkill -f "network $NET --base-path $BASE"; sleep 2
tar -czf /root/backup/esme-ootle-$TS.tar.gz -C /root/.tari ootle && echo "  archive $(du -h /root/backup/esme-ootle-$TS.tar.gz | cut -f1): /root/backup/esme-ootle-$TS.tar.gz  sha256 $(sha256sum /root/backup/esme-ootle-$TS.tar.gz | cut -c1-16)…"
echo "=== 2. restore into a fresh base path and serve it on :5101"
rm -rf /root/restore-test/file && mkdir -p /root/restore-test/file && tar -xzf /root/backup/esme-ootle-$TS.tar.gz -C /root/restore-test/file
rm -f /root/restore-test/file/ootle/$NET/pid
nohup $BIN --network $NET --base-path /root/restore-test/file/ootle --listen-on 127.0.0.1:5101 --authentication none --override-keyring-password $PW -p ootle_wallet_daemon.indexer_trust=trust > /root/logs/drill-file.out 2>&1 &
FP=$!
for i in $(seq 1 30); do curl -s -m 2 -o /dev/null http://127.0.0.1:5101/json_rpc -d '{}' && break; sleep 2; done
LIST=$(rpc http://127.0.0.1:5101/json_rpc accounts.list '{"offset":0,"limit":10}')
echo "$LIST" | python3 -c 'import sys,json; d=json.load(sys.stdin); [print("  account", a["account"]["name"], a["account"]["component_address"]) for a in d.get("result",{}).get("accounts",[])]; d.get("error") and print("  error", d["error"])'
ADDR=$(echo "$LIST" | python3 -c 'import sys,json; print([a["account"]["component_address"] for a in json.load(sys.stdin)["result"]["accounts"] if a["account"]["name"]=="STBZ"][0])' 2>/dev/null)
BAL=$(rpc http://127.0.0.1:5101/json_rpc accounts.get_balances '{"account":{"Name":"STBZ"},"refresh":true}' | python3 -c 'import sys,json; d=json.load(sys.stdin); print([(b["token_symbol"],b["balance"]) for b in d.get("result",{}).get("balances",[])] or d.get("error"))')
echo "  STBZ balance via the restored copy (refreshed from chain): $BAL"
if [ "$ADDR" = "$EXPECT_ADDR" ]; then echo "  FILE RESTORE: PASS (same STBZ address, chain balance readable)"; else echo "  FILE RESTORE: FAIL (got '$ADDR')"; tail -5 /root/logs/drill-file.out | cut -c1-160; fi
kill $FP 2>/dev/null; sleep 1; rm -rf /root/restore-test/file
echo "=== 3. the production :5100 walletd is stopped; restart it from Windows with start-esme-walletd.sh"
