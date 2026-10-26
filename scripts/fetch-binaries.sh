#!/usr/bin/env bash
# Fetch the prebuilt Tari binaries that the local swarm runs, so you don't need the ~400 MB
# node-binaries/ checkout (it's .gitignored and not in the repo). Linux x86_64 only.
#
#   bash scripts/fetch-binaries.sh            # download + verify into node-binaries/bins
#   DEST=/root/ootle/swarm/bin bash scripts/fetch-binaries.sh
#
# Versions (from docs/devnet.md — the match matters: a mismatched L1 fails validator-node
# registration with "Invalid validator node signature"):
#
#   L2  tari-project/tari-ootle  v0.47.0   -> tari_swarm_daemon tari_validator_node
#                                             tari_indexer tari_ootle_walletd
#   L1  tari-project/tari        v6.2.0-pre.2  (the "esme" suite, NOT mainnet — mainnet binaries
#                                             reject localnet) -> minotari_node
#                                             minotari_console_wallet minotari_miner
#
# The L2 binaries are checksum-verified against the committed
# node-binaries/bins/tari_ootle-0.47.0-9dabb2a-linux-x86_64.sha256.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DEST:-$ROOT/node-binaries/bins}"
SHAFILE="$ROOT/node-binaries/bins/tari_ootle-0.47.0-9dabb2a-linux-x86_64.sha256"

OOTLE_TAG="v0.47.0"
TARI_TAG="v6.2.0-pre.2"

# -------------------------------------------------------------------------------------------
# IMPORTANT — fill these in from the actual GitHub release pages before running.
# The exact asset file names (archive vs per-binary, .zip vs .tar.gz, the embedded git short-sha
# like "9dabb2a") are NOT guessed here on purpose — check the releases and set the URLs:
#
#   L2: https://github.com/tari-project/tari-ootle/releases/tag/v0.47.0
#   L1: https://github.com/tari-project/tari/releases/tag/v6.2.0-pre.2
#
# Set OOTLE_ARCHIVE_URL to the linux-x86_64 archive that contains the four L2 binaries, and
# TARI_ARCHIVE_URL to the esme linux-x86_64 archive with the three minotari binaries. Leave a
# value empty to skip that half (and get printed manual instructions instead).
# -------------------------------------------------------------------------------------------
OOTLE_ARCHIVE_URL="${OOTLE_ARCHIVE_URL:-}"   # e.g. .../releases/download/v0.47.0/tari_ootle-0.47.0-9dabb2a-linux-x86_64.zip
TARI_ARCHIVE_URL="${TARI_ARCHIVE_URL:-}"     # e.g. .../releases/download/v6.2.0-pre.2/tari_suite-...-esmeralda-x86_64.zip

OOTLE_BINS=(tari_swarm_daemon tari_validator_node tari_indexer tari_ootle_walletd)
TARI_BINS=(minotari_node minotari_console_wallet minotari_miner)

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

extract_into() { # <archive> <out-dir>
  local a="$1" out="$2"
  case "$a" in
    *.zip)              unzip -o -q "$a" -d "$out" ;;
    *.tar.gz|*.tgz)     tar -xzf "$a" -C "$out" ;;
    *.tar.xz)           tar -xJf "$a" -C "$out" ;;
    *)                  echo "don't know how to extract $a" >&2; return 1 ;;
  esac
}

fetch() { # <url> <archive-basename> <out-dir>
  local url="$1" name="$2" out="$3"
  echo "downloading $name ..."
  curl -fL --proto '=https' --tlsv1.2 -o "$TMP/$name" "$url"
  mkdir -p "$out"
  extract_into "$TMP/$name" "$out"
}

place() { # copy wanted binaries out of an extracted tree into $DEST, make them executable
  local tree="$1"; shift
  for b in "$@"; do
    local src
    src="$(find "$tree" -type f -name "$b" | head -1 || true)"
    if [ -z "$src" ]; then echo "  !! $b not found in archive" >&2; continue; fi
    install -m 0755 "$src" "$DEST/$b"
    echo "  placed $b"
  done
}

# ---- L2 (tari-ootle) ----
if [ -n "$OOTLE_ARCHIVE_URL" ]; then
  fetch "$OOTLE_ARCHIVE_URL" "ootle.archive" "$TMP/ootle"
  place "$TMP/ootle" "${OOTLE_BINS[@]}"
else
  echo "OOTLE_ARCHIVE_URL not set — skipping L2. Get it from:"
  echo "  https://github.com/tari-project/tari-ootle/releases/tag/$OOTLE_TAG"
  echo "  (need: ${OOTLE_BINS[*]}), then re-run with OOTLE_ARCHIVE_URL=<url>"
fi

# ---- L1 (minotari, esme suite) ----
if [ -n "$TARI_ARCHIVE_URL" ]; then
  fetch "$TARI_ARCHIVE_URL" "tari.archive" "$TMP/tari"
  place "$TMP/tari" "${TARI_BINS[@]}"
else
  echo "TARI_ARCHIVE_URL not set — skipping L1. Get the ESME (not mainnet) suite from:"
  echo "  https://github.com/tari-project/tari/releases/tag/$TARI_TAG"
  echo "  (need: ${TARI_BINS[*]}), then re-run with TARI_ARCHIVE_URL=<url>"
fi

# ---- verify L2 checksums (if the binaries are present) ----
if [ -f "$SHAFILE" ]; then
  echo "verifying L2 checksums against $(basename "$SHAFILE") ..."
  if ( cd "$DEST" && sha256sum -c "$SHAFILE" ); then
    echo "L2 checksums OK."
  else
    echo "!! checksum mismatch — the downloaded L2 asset is not v0.47.0/9dabb2a. Check the URL." >&2
    exit 1
  fi
fi

echo "done. Binaries in: $DEST"
echo "Next: install the walletd keyring wrapper (docs/devnet.md §2) and 'make swarm-up'."
