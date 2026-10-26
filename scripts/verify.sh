#!/usr/bin/env bash
set -u
W="http://127.0.0.1:12010/json_rpc"
IDX="http://127.0.0.1:12009/json_rpc"
TPL="template_458a0933b2f6f7c68dda941b488e7ca2ae411d5af705d4adfa07f3be2eb7e8ff"
TOKEN=$(curl -s -X POST "$W" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"auth.request","params":{"permissions":["Admin"],"duration":null,"credentials":"None"}}' \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')

echo "=== account balance after publish ==="
curl -s -X POST "$W" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"accounts.get_balances","params":{"account":{"Name":"default"},"refresh":true}}' | head -c 400
echo
echo "=== template on-chain via indexer get_substate ==="
curl -s -X POST "$IDX" -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"get_substate\",\"params\":{\"address\":\"$TPL\",\"version\":null}}" | head -c 500
echo
