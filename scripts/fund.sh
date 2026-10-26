#!/usr/bin/env bash
# Mint an admin token on the swarm walletd (none-auth), then fund the default account.
set -u
URL="http://127.0.0.1:12010/json_rpc"

rpc() { # method params
  curl -s -X POST "$URL" -H "Content-Type: application/json" \
    ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"
}

# 1. mint token (none-auth)
TOKEN=""
RESP=$(rpc "auth.request" '{"permissions":["Admin"],"duration":null,"credentials":"None"}')
TOKEN=$(printf '%s' "$RESP" | sed -E 's/.*"token":"([^"]+)".*/\1/')
echo "token-len=${#TOKEN}"

echo "=== balances before ==="
rpc "accounts.get_balances" '{"account":{"Name":"default"},"refresh":true}'; echo

echo "=== create_free_test_coins ==="
rpc "accounts.create_free_test_coins" '{"account":{"Name":"default"},"amount":1000000,"max_fee":2000,"key_id":null}' | head -c 800; echo

echo "=== balances after ==="
rpc "accounts.get_balances" '{"account":{"Name":"default"},"refresh":true}'; echo

# expose token for later steps
echo "$TOKEN" > /root/ootle/swarm/walletd.token
echo "token saved to /root/ootle/swarm/walletd.token"
