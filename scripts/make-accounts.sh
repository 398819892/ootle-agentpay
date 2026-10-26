#!/usr/bin/env bash
set -u
URL="http://127.0.0.1:12010/json_rpc"
TOKEN=$(curl -s -X POST "$URL" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"auth.request","params":{"permissions":["Admin"],"duration":null,"credentials":"None"}}' \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
printf '%s' "$TOKEN" > /root/ootle/swarm/walletd.token
rpc() { curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }

for name in bob fees; do
  echo "=== create $name ==="
  rpc "accounts.create" "{\"account_name\":\"$name\",\"custom_access_rules\":null,\"max_fee\":null,\"is_default\":false,\"key_id\":null}" | head -c 120; echo
  echo "=== fund $name ==="
  rpc "accounts.create_free_test_coins" "{\"account\":{\"Name\":\"$name\"},\"amount\":1000000,\"max_fee\":50000,\"key_id\":null}" | head -c 120; echo
done

echo "=== accounts.list (name / component / owner_public_key) ==="
rpc "accounts.list" '{"offset":0,"limit":20}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); [print(a["account"]["name"], a["account"]["component_address"], a["account"]["owner_public_key"]) for a in d["result"]["accounts"]]' 2>/dev/null \
  || rpc "accounts.list" '{"offset":0,"limit":20}' | head -c 1500
