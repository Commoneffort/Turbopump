#!/bin/sh
# Upgrades the router program on one test network to the build with standing orders (stop,
# take-profit, trailing stop, limit, TWAP), then says what to restart. The new binary is larger
# than the one deployed, so the program's account is extended first (a little rent, paid once).
#
#   deploy/upgrade-router.sh x1        X1 testnet   (key ~/.config/solana/percolator-x1/deployer.json)
#   deploy/upgrade-router.sh devnet    Solana devnet (key ~/.config/solana/percolator-test/deployer.json)
#
# Requests already queued keep working: the request account did not change size, and trades,
# fills and expiry behave as before. Run ./test.sh first if the code changed since it last passed.
set -e
cd "$(dirname "$0")/.."
ROUTER=DkK9TSMpVXLq26HeqxTXLysXyRKDYHTKU94SLFDWgjw3
case "$1" in
  x1)     RPC=${X1_RPC:-https://rpc.testnet.x1.xyz}; KEY=$HOME/.config/solana/percolator-x1/deployer.json; FEATURES=devnet,x1; OUT=target/deploy-x1 ;;
  devnet) RPC=${DEVNET_RPC:-https://api.devnet.solana.com}; KEY=$HOME/.config/solana/percolator-test/deployer.json; FEATURES=devnet; OUT=target/deploy-devnet ;;
  *) echo "usage: $0 x1 | devnet"; exit 1 ;;
esac
(cd router && cargo build-sbf --tools-version v1.53 --features $FEATURES --sbf-out-dir ../$OUT >/dev/null 2>&1 || cargo build-sbf --tools-version v1.53 --features $FEATURES --sbf-out-dir ../$OUT)
SO=$OUT/percolator_router.so
have=$(solana program show -u "$RPC" $ROUTER | sed -n 's/^Data Length: \([0-9]*\).*/\1/p')
need=$(stat -c %s "$SO")
echo "router on $RPC: $have bytes deployed, the new build is $need"
if [ "$need" -gt "$have" ]; then
  # (Solana refuses to extend a program by less than 10,240 bytes.)
  more=$((need - have + 8192)); [ "$more" -lt 10240 ] && more=10240
  solana program extend -u "$RPC" -k "$KEY" $ROUTER $more
fi
solana program deploy -u "$RPC" -k "$KEY" --program-id keys/router-keypair.json --upgrade-authority "$KEY" "$SO"
solana program show -u "$RPC" $ROUTER | grep -E "Slot|Length"
cat <<MSG

Done. Now restart the executor on this network so it carries orders out
(X1: deploy/x1-services.sh stop && deploy/x1-services.sh start), then publish the site
(cd app && npx vercel --prod --yes): the order ticket's Limit, TP / SL and TWAP tabs need this build.
To check: NETWORK=<x1-testnet|devnet> npx tsx app/scripts/orders-smoke.ts   (from app/)
MSG
