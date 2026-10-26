#!/usr/bin/env bash
export PATH="/root/.cargo/bin:/usr/bin:/bin"
TP="/mnt/c/Users/cam/AppData/Local/Temp/claude/F--oolte/e19fe688-4ea6-4c61-84ea-b404912b4961/scratchpad/token.py"
mkdir -p /root/esme-publish-logs
for t in "$@"; do
  echo "######## $t ########"
  for i in $(seq 1 30); do
    TOK=$(python3 "$TP")
    LOG=/root/esme-publish-logs/$t.log
    printf "N\nN\n" | script -qec "cd /root/ootle/$t && tari publish -n esmeralda -a dev -y --api-key $TOK --wallet-daemon-url http://127.0.0.1:5100/json_rpc" "$LOG" >/dev/null 2>&1
    ADDR=$(grep -ioE "template_[0-9a-f]{64}" "$LOG" | sort -u | tail -1)
    if [ -n "$ADDR" ]; then
      echo "attempt $i: SUCCESS $t: $ADDR"
      break
    fi
    ERR=$(grep -iE "error|did not respond|Reject|denied|insufficient" "$LOG" | tr -d "\r" | sed "s/\x1b\[[0-9;]*m//g" | tail -1)
    echo "attempt $i: fail -> $ERR"
    # retry only on transient indexer errors; stop otherwise
    if echo "$ERR" | grep -qiE "did not respond|timed out|timeout|Network interface|checkpoint|503|502|http2|stream error|SendRequest|connection error|Indexer client error|Failed to send request|Failed to submit"; then
      sleep 12; continue
    fi
    echo "attempt $i: NON-TRANSIENT, stop $t"; break
  done
done
echo "=== FINAL ==="
for t in "$@"; do
  echo "$t: $(grep -ioE "template_[0-9a-f]{64}" /root/esme-publish-logs/$t.log | sort -u | tail -1)"
done
