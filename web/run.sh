#!/usr/bin/env bash
# One-command launcher for the AgentPay dashboard.
#
# Zero dependencies: it only needs Node 18+ (for the global fetch the TS client uses) and the
# committed clients/ts/dist (already built). No npm install, no bundler.
#
#   ./run.sh                 # serve on http://localhost:8787, against the local swarm
#   PORT=9000 ./run.sh       # pick a port
#   AGENTPAY_WALLETD_URL=... AGENTPAY_BUDGET_TEMPLATE=... AGENTPAY_OWNER_ACCOUNT=... ./run.sh
#
# On Windows the swarm + Node live in WSL, so run this from WSL:
#   wsl bash /mnt/f/oolte/web/run.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node 18+ is required but 'node' was not found on PATH." >&2
  exit 1
fi

DIST="$DIR/../clients/ts/dist/index.js"
if [ ! -f "$DIST" ]; then
  echo "The TS client isn't built. Run once:  (cd \"$DIR/../clients/ts\" && npm install && npm run build)" >&2
  exit 1
fi

exec node "$DIR/server/server.js"
