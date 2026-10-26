#!/usr/bin/env bash
set -u
URL="http://127.0.0.1:12010/json_rpc"
TOKEN=$(cat /root/ootle/swarm/walletd.token)
call() {
  curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"transactions.submit_manifest\",\"params\":$1}" | head -c 300
  echo
}
echo "1:"; call '{"manifest":"fn main(){}"}'
echo "2:"; call '{"manifest":"fn main(){}","signing_key_index":null,"globals":{},"detect_inputs":true,"proof_ids":[]}'
echo "3:"; call '{"manifest":"fn main(){}","signing_key_index":null,"globals":{},"detect_inputs":true,"proof_ids":[],"min_epoch":null,"max_epoch":null}'
