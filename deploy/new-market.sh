#!/bin/bash
# Moves one test network to a new Percolator market (2026-10-17: 5% / 2.5% margins, so the
# router's tiers can allow 20x on BTC and ETH and 10x on the rest). Percolator fixes a market's
# margins when it is created, so more leverage means a new market; the old one stays on chain but
# nothing services it any more (its manifest is kept as deploy/<network>.market-<old>.json).
#
#   deploy/new-market.sh x1|devnet [seed USDC per vault, default 10000]
#
# Steps: stop the network's bots and services; keep the old manifest; create the market (same test
# USDC and treasury account) and hand it to the governor; set the 10 bps trade fee; write the app's
# manifest; start the services (the X1 executor posts the prices a listing needs); open SOL, BTC,
# ETH with their tiers and seed liquidity; wait for the first epoch to roll; start the bots and the
# copy traders. Needs the router build with tiers deployed first (deploy/upgrade-program.sh router).
# Afterwards the page has to be published again (it reads the market from app/src/<network>.json).
set -e
cd "$(dirname "$0")/.."
NET=$1; SEED=${2:-10000}
case "$NET" in
  x1)     N=x1-testnet; RPC=${X1_RPC:-https://rpc.testnet.x1.xyz}; KEY=$HOME/.config/solana/percolator-x1/deployer.json; MAN=deploy/x1-testnet.json; TOOL=deploy/x1-tool; FAUCET=keys/x1-faucet.json; SVC=deploy/x1-services.sh ;;
  devnet) N=devnet; RPC=${DEVNET_RPC:-https://api.devnet.solana.com}; KEY=$HOME/.config/solana/percolator-test/deployer.json; MAN=deploy/devnet.json; TOOL=deploy/devnet-tool; FAUCET=keys/faucet.json; SVC=deploy/devnet-services.sh ;;
  *) echo "usage: $0 x1|devnet [seed USDC]"; exit 1 ;;
esac
say() { echo "$(date -u +%T) $*"; }
OLD=$(python3 -c "import json;print(json.load(open('$MAN'))['market'])")
say "== $N: old market $OLD"
deploy/bots.sh $NET stop || true
$SVC stop || true

say "== keep the old manifest, start a new one (same test USDC and treasury account)"
cp $MAN deploy/$N.market-${OLD:0:8}.json
python3 - "$MAN" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
keep = {k: m[k] for k in ["network", "percolator_program", "vault_program", "collateral_mint", "admin", "treasury_collateral"] if k in m}
json.dump(keep, open(sys.argv[1], "w"), indent=2)
PY

say "== keeper tool (with the new market's margins) and the market"
cargo build --example devnet --features devnet 2>/dev/null
cp target/debug/examples/devnet $TOOL.new && mv $TOOL.new $TOOL
export PERCOLATOR_FIT_COMPUTE=1 PERCOLATOR_MANIFEST=$MAN PERCOLATOR_NETWORK=$N DEVNET_RPC=$RPC PERCOLATOR_KEYPAIR=$KEY PERCOLATOR_FAUCET_KEY=$FAUCET
$TOOL setup-market
$TOOL accept-governance
$TOOL set-trade-fee 2>/dev/null || true
python3 - "$MAN" "app/src/$N.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
keep = ["network", "percolator_program", "vault_program", "collateral_mint", "market", "percolator_vault", "percolator_vault_authority", "admin"]
json.dump({k: m[k] for k in keep if k in m}, open(sys.argv[2], "w"), indent=2)
print("   new market", m["market"])
PY

# On X1 the executor has to run first (it posts the prices a listing needs). On devnet Pyth's
# own feed accounts serve, and the services are kept off meanwhile: the public RPC refuses the
# account scans of a listing while they run (429 "too many requests for a specific RPC call").
open_markets() { (cd app && NETWORK=$N RPC=$RPC KEYPAIR=$KEY FAUCET_KEY=../$FAUCET npx tsx scripts/open-markets.ts SOL,BTC,ETH $SEED 2>&1 | grep -v -i "punycode\|deprecation\|Retrying after"); }
if [ "$NET" = x1 ]; then
  say "== services, then the markets"; $SVC start; sleep 20; open_markets
else
  say "== the markets, then the services"; open_markets; $SVC start
fi
$TOOL set-trade-fee 2>/dev/null || true # (refused when the fee is already 10 bps)

say "== waiting for the first epoch to roll (the seed becomes liquidity then; about 10 minutes)"
for i in $(seq 90); do
  n=$(cd app && NETWORK=$N RPC=$RPC npx tsx -e 'import { Connection } from "@solana/web3.js"; import * as C from "./src/chain"; const c = new Connection(process.env.RPC!); C.listVaults(c).then(v => console.log(v.filter(x => x.canonical && x.status === 1 && x.lastNav > 0n).length))' 2>/dev/null | tail -1)
  [ "${n:-0}" -ge 3 ] && break
  sleep 20
done
say "   vaults with liquidity: ${n:-0}"

say "== bots and copy traders"
deploy/bots.sh $NET start
(cd app && NETWORK=$N RPC=$RPC npx tsx scripts/copy-bots.ts setup 2>&1 | grep -v -i "punycode\|deprecation" | tail -5) || say "copy-bots setup failed: run it again later"
say "done. Publish the page (cd app, then npx vercel --prod --yes): it still points at the old market until then."
