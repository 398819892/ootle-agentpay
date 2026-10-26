#!/usr/bin/env bash
set -u
source "$HOME/.cargo/env"
URL="http://127.0.0.1:12010/json_rpc"
TOKEN=$(curl -s -X POST "$URL" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"auth.request","params":{"permissions":["Admin"],"duration":null,"credentials":"None"}}' \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
echo "token-len=${#TOKEN}"
export TARI_WALLET_DAEMON_API_KEY="$TOKEN"
cd /root/ootle/agent_budget
tari -n localnet publish -a default -y --wallet-daemon-url "$URL"
echo "PUBLISH_EXIT=$?"
