#!/usr/bin/env bash
set -u
URL="http://127.0.0.1:12010/json_rpc"
TOKEN=$(curl -s -X POST "$URL" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"auth.request","params":{"permissions":["Admin"],"duration":null,"credentials":"None"}}' \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
printf '%s' "$TOKEN" > /root/ootle/swarm/walletd.token
for m in transactions.submit transactions.submit_instructions transactions.submit_manifest transactions.publish_template transactions.call transactions.get transactions.get_result; do
  echo "--- $m ---"
  curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$m\",\"params\":{}}" | head -c 220
  echo
done
