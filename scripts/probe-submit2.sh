#!/usr/bin/env bash
set -u
URL="http://127.0.0.1:12010/json_rpc"
TOKEN=$(cat /root/ootle/swarm/walletd.token)
call() {
  curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"transactions.submit_manifest\",\"params\":$1}" | head -c 320
  echo
}
echo "A:"; call '{"manifest":"fn main(){}","variables":{}}'
echo "B:"; call '{"manifest":"fn main(){}","variables":{},"signing_key_index":null,"detect_inputs":true}'
echo "C:"; call '{"manifest":"fn main(){}","variables":{},"signing_key_index":null,"detect_inputs":true,"fee_account":null,"inputs":[],"min_epoch":null,"max_epoch":null,"proof_ids":[],"is_dry_run":false}'
