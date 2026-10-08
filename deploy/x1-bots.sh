#!/bin/bash
# The X1 testnet trading bots: see deploy/bots.sh (this is `deploy/bots.sh x1 ...`).
exec "$(dirname "$0")/bots.sh" x1 "$@"
