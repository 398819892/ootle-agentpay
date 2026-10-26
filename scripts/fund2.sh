#!/usr/bin/env bash
set -u
URL="http://127.0.0.1:12010/json_rpc"
TOKEN=$(cat /root/ootle/swarm/walletd.token | tr -d '\r\n')
rpc() { curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }

echo "=== create_free_test_coins (default) ==="
rpc "accounts.create_free_test_coins" '{"account":{"Name":"default"},"amount":1000000,"max_fee":2000,"key_id":null}' | head -c 900; echo
echo "=== wait + balances ==="
sleep 6
rpc "accounts.get_balances" '{"account":{"Name":"default"},"refresh":true}' | head -c 900; echo
