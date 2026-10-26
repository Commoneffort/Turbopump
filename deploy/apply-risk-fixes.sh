#!/bin/bash
# Puts the 2026-10-20 risk fixes live on both test networks, in order. Each step stops the
# script if it fails. Run it from anywhere:
#
#   deploy/apply-risk-fixes.sh
#
# 1. The vault and router programs, on X1 testnet then devnet (deploy/upgrade-program.sh builds,
#    upgrades and checks each one byte for byte). The devnet bots are stopped for the upload.
# 2. The services again, so they run the new executor (grouped fills, liquidations queued
#    together, the backstop crank), the two price sources and the witness on X1, and the fill log
#    for payouts on both networks. Then the bots.
# 3. The web page (Vercel).
# Moving the programs' upgrade rights to their own key is a separate step, on purpose (it is hard
# to undo): deploy/move-upgrade-authority.sh, once this has worked.
set -e
cd "$(dirname "$0")/.."
say() { echo; echo "== $*"; }

say "programs on X1 testnet"
deploy/upgrade-program.sh vault x1
deploy/upgrade-program.sh router x1

say "programs on Solana devnet (bots paused for the upload)"
deploy/bots.sh devnet stop || true
deploy/upgrade-program.sh vault devnet
deploy/upgrade-program.sh router devnet

say "keeper tools (the vault crate changed)"
# (The same build as deploy/x1-testnet.sh makes; both networks' keepers use it.)
cargo build --example devnet --features devnet 2>/dev/null
cp target/debug/examples/devnet deploy/x1-tool.new && mv deploy/x1-tool.new deploy/x1-tool
cp target/debug/examples/devnet deploy/devnet-tool.new && mv deploy/devnet-tool.new deploy/devnet-tool

say "services"
deploy/x1-services.sh stop
deploy/x1-services.sh start
deploy/devnet-services.sh stop
deploy/devnet-services.sh start

say "bots"
deploy/bots.sh x1 stop || true
deploy/bots.sh x1 start
deploy/bots.sh devnet start

say "web page"
(cd app && npx vercel --prod --yes)

say "done. Next, when you are ready: deploy/move-upgrade-authority.sh"
