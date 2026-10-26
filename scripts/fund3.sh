#!/usr/bin/env bash
set -u
URL="http://127.0.0.1:12010/json_rpc"
TOKEN=$(curl -s -X POST "$URL" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"auth.request","params":{"permissions":["Admin"],"duration":null,"credentials":"None"}}' \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
echo "token-len=${#TOKEN}"
printf '%s' "$TOKEN" > /root/ootle/swarm/walletd.token
rpc() { curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }

echo "=== create_free_test_coins (default, max_fee 50000) ==="
rpc "accounts.create_free_test_coins" '{"account":{"Name":"default"},"amount":1000000,"max_fee":50000,"key_id":null}' | head -c 900; echo
sleep 10
echo "=== balances ==="
rpc "accounts.get_balances" '{"account":{"Name":"default"},"refresh":true}' | head -c 900; echo
