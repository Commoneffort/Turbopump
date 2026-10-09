#!/bin/bash
# One-time, per network: creates the platform treasury's collateral (USDC) token account and
# writes its address into the manifest, where the keeper reads it when it harvests fees.
#   deploy/treasury-setup.sh x1 | devnet
# The treasury key is ~/.config/solana/percolator-treasury.json; it signs nothing here.
set -e
cd "$(dirname "$0")/.."
case "$1" in
  x1)     RPC=${X1_RPC:-https://rpc.testnet.x1.xyz}; KEY=$HOME/.config/solana/percolator-x1/deployer.json; MAN=deploy/x1-testnet.json ;;
  devnet) RPC=${DEVNET_RPC:-https://api.devnet.solana.com}; KEY=$HOME/.config/solana/percolator-test/deployer.json; MAN=deploy/devnet.json ;;
  *) echo "usage: $0 x1|devnet"; exit 1 ;;
esac
TREASURY=B9Ke1KTC8x46ZxAMTa7oU73HXEzPXt17GC7bZujxiiWV
MINT=$(python3 -c "import json;print(json.load(open('$MAN'))['collateral_mint'])")
spl-token create-account "$MINT" --owner $TREASURY --fee-payer "$KEY" -u "$RPC" || true
ACC=$(spl-token address --token "$MINT" --owner $TREASURY --verbose -u "$RPC" | awk '/Associated token address/ {print $NF}')
[ -n "$ACC" ] || { echo "could not find the treasury's token account"; exit 1; }
python3 - "$MAN" "$ACC" <<'PY'
import json, sys
p, acc = sys.argv[1], sys.argv[2]
m = json.load(open(p)); m["treasury_collateral"] = acc
json.dump(m, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
echo "treasury collateral account $ACC written to $MAN"
