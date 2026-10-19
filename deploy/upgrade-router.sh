#!/bin/sh
# Upgrades the router on one test network (kept for old notes: deploy/upgrade-program.sh does it).
#   deploy/upgrade-router.sh x1 | devnet
exec "$(dirname "$0")/upgrade-program.sh" router "$1"
