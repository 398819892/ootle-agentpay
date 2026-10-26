#!/usr/bin/env bash
set -u
URL="http://127.0.0.1:12010/json_rpc"
TOKEN=$(cat /root/ootle/swarm/walletd.token)
call() {
  curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"transactions.submit_manifest\",\"params\":$1}" | head -c 400
  echo
}
echo "A:"; call '{"manifest":"fn main(){}","variables":{},"max_fee":2000,"dry_run":true}'
echo "B:"; call '{"manifest":"fn main(){}","variables":{},"max_fee":2000,"dry_run":true,"detect_inputs":true,"signing_key_index":null}'
echo "C:"; call '{"manifest":"fn main(){}","variables":{},"max_fee":2000,"dry_run":true,"detect_inputs":true,"signing_key_index":null,"inputs":[],"min_epoch":null,"max_epoch":null,"proof_ids":[],"fee_account":null}'
