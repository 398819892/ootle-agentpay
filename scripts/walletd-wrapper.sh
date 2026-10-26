#!/bin/bash
# Wrapper: inject keyring password (WSL has no OS keyring) into every walletd call.
exec /root/ootle/swarm/bin/tari_ootle_walletd.real --override-keyring-password devswarm "$@"
