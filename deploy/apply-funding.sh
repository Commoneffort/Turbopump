#!/bin/bash
# Puts funding live on both test networks, in the only safe order. Each step stops the script if it
# fails, and a rerun skips a program that is already live (deploy/upgrade-program.sh checks).
#
#   deploy/apply-funding.sh
#
# 1. Percolator (our fork: PushAuthFunding / UpdateFundingCap, exact funding indices), uploaded from
#    ../percolator-prog/target/deploy/percolator_prog.so, built from branch funding/authority-rate
#    with `cargo build-sbf --tools-version v1.52` against the engine at ../_wt_eng (branch
#    funding/precision). Replay-tested on copies of both live markets taken 2026-10-20: with no
#    funding cap it behaves exactly as the build it replaces.
# 2. The vault program (PushFunding, SetFundingCap), then the router (rate after each fill,
#    RefreshFunding). Until step 3 a market's cap is 0 and none of this changes anything.
# 3. Funding switched on for each network's market (app/scripts/funding.ts on).
# 4. The services again (the executor steps quiet markets' rates), the bots, and the web page.
set -e
cd "$(dirname "$0")/.."
say() { echo; echo "== $*"; }

say "Percolator on X1 testnet, then devnet (devnet bots paused for the uploads)"
deploy/upgrade-program.sh engine x1
deploy/bots.sh devnet stop || true
deploy/upgrade-program.sh engine devnet

say "vault and router, X1 then devnet"
deploy/upgrade-program.sh vault x1
deploy/upgrade-program.sh router x1
deploy/upgrade-program.sh vault devnet
deploy/upgrade-program.sh router devnet

say "keeper tools"
cargo build --example devnet --features devnet 2>/dev/null
cp target/debug/examples/devnet deploy/x1-tool.new && mv deploy/x1-tool.new deploy/x1-tool
cp target/debug/examples/devnet deploy/devnet-tool.new && mv deploy/devnet-tool.new deploy/devnet-tool

say "funding on"
(cd app && NETWORK=x1-testnet npx tsx scripts/funding.ts on)
(cd app && NETWORK=devnet RPC=$(cat ~/.config/percolator/devnet-rpc 2>/dev/null || echo https://api.devnet.solana.com) npx tsx scripts/funding.ts on)

say "services and bots"
deploy/x1-services.sh stop; deploy/x1-services.sh start
deploy/devnet-services.sh stop; deploy/devnet-services.sh start
deploy/bots.sh x1 stop || true
deploy/bots.sh x1 start
deploy/bots.sh devnet start

say "web page"
(cd app && npx vercel --prod --yes)

say "done. Rates: cd app && NETWORK=x1-testnet npx tsx scripts/funding.ts"
