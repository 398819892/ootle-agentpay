#!/usr/bin/env bash
set -u
URL="http://127.0.0.1:12010/json_rpc"
TOKEN=$(curl -s -X POST "$URL" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"auth.request","params":{"permissions":["Admin"],"duration":null,"credentials":"None"}}' \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
TOKEN=$(printf '%s' "$TOKEN" | tr -d '\r\n')
echo "token-len=${#TOKEN}"
printf '%s' "$TOKEN" > /root/ootle/swarm/walletd.token

rpc() { curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }

echo "=== keys.list ==="; rpc "keys.list" '{}' | head -c 400; echo
echo "=== accounts.list ==="; rpc "accounts.list" '{"offset":0,"limit":20}' | head -c 800; echo
echo "=== accounts.create name=default ==="
rpc "accounts.create" '{"account_name":"default","custom_access_rules":null,"max_fee":null,"is_default":true,"key_id":null}' | head -c 800; echo
echo "=== accounts.list after ==="; rpc "accounts.list" '{"offset":0,"limit":20}' | head -c 800; echo
