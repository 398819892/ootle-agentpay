#!/usr/bin/env bash
# usage: rpc.sh <API_KEY>
set -u
KEY="$1"
URL="http://127.0.0.1:5100/json_rpc"
call() {
  local method="$1"; local params="$2"
  curl -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $KEY" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
  echo
}
echo "=== accounts.list (verify key) ==="
call "accounts.list" '{"offset":0,"limit":10}'
echo "=== accounts.get_balances (dev) ==="
call "accounts.get_balances" '{"account":{"Name":"dev"},"refresh":true}'
echo "=== create_free_test_coins (amount only) ==="
call "accounts.create_free_test_coins" '{"account":{"Name":"dev"},"amount":1000000,"max_fee":null,"key_id":null}'
