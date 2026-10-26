#!/bin/bash
# Switches funding off on both test networks (2026-10-20). With a nonzero rate, Percolator marks
# every position on a market out of date at each accrual, and refuses trades until they are all
# settled again, so nearly every fill failed (see CANON_MAX_FUNDING_E9 in src/processor.rs).
#
#   deploy/funding-off.sh
#
# 1. The vault program with CANON_MAX_FUNDING_E9 = 0, on X1 testnet and devnet.
# 2. SetFundingCap on each network's market: its cap goes to 0. Percolator then applies no
#    funding at all, and the router's rate updates do nothing.
# 3. The services again (the executors running were started before today's upgrades), and the
#    web page. A rerun skips what is already done.
set -e
cd "$(dirname "$0")/.."
say() { echo; echo "== $*"; }

say "vault program, X1 then devnet"
deploy/upgrade-program.sh vault x1
deploy/upgrade-program.sh vault devnet

say "funding off"
(cd app && NETWORK=x1-testnet npx tsx scripts/funding.ts off)
(cd app && NETWORK=devnet RPC=$(cat ~/.config/percolator/devnet-rpc 2>/dev/null || echo https://api.devnet.solana.com) npx tsx scripts/funding.ts off)

say "services"
deploy/x1-services.sh stop; deploy/x1-services.sh start
deploy/devnet-services.sh stop; deploy/devnet-services.sh start

say "web page"
(cd app && npx vercel --prod --yes)

say "done"
