#!/bin/sh
# Deploys Percolator, the vault and the router to X1 testnet and sets up a market there, with a
# test USDC (6 decimals) as collateral. Safe to run again: each step is skipped if already done.
#
# The programs keep the addresses they have on Solana devnet (the same program keys). The vault
# and router are built for X1: prices come from the router's reporter key instead of Pyth.
#
#   deploy/x1-testnet.sh            everything below
#   X1_RPC=http://127.0.0.1:18899 deploy/x1-testnet.sh    a rehearsal on a local validator
#
# Needs about 25 XNT in the deploy wallet (12 stays as the programs' rent, 9 comes back when
# the largest upload finishes).
set -e
cd "$(dirname "$0")/.."
RPC=${X1_RPC:-https://rpc.testnet.x1.xyz}
KEY=${PERCOLATOR_KEYPAIR:-$HOME/.config/solana/percolator-x1/deployer.json}
MANIFEST=${PERCOLATOR_MANIFEST:-deploy/x1-testnet.json}
export PERCOLATOR_MANIFEST=$MANIFEST PERCOLATOR_NETWORK=x1-testnet DEVNET_RPC=$RPC PERCOLATOR_KEYPAIR=$KEY PERCOLATOR_FAUCET_KEY=${PERCOLATOR_FAUCET_KEY:-keys/x1-faucet.json} PERCOLATOR_FIT_COMPUTE=1
ME=$(solana-keygen pubkey "$KEY")
echo "deploy wallet $ME on $RPC: $(solana balance -u "$RPC" "$ME")"

echo "== build (X1: reported prices)"
cargo build-sbf --tools-version v1.53 --features devnet,x1 --sbf-out-dir target/deploy-x1 >/dev/null 2>&1 || cargo build-sbf --tools-version v1.53 --features devnet,x1 --sbf-out-dir target/deploy-x1
(cd router && cargo build-sbf --tools-version v1.53 --features devnet,x1 --sbf-out-dir ../target/deploy-x1 >/dev/null 2>&1 || cargo build-sbf --tools-version v1.53 --features devnet,x1 --sbf-out-dir ../target/deploy-x1)
cargo build --example devnet --features devnet 2>/dev/null
# Replaced by rename, so a keeper that is running the old file is not disturbed.
cp target/debug/examples/devnet deploy/x1-tool.new && mv deploy/x1-tool.new deploy/x1-tool

# Deploys a program at its key's address unless that exact binary is already there.
deploy() { # <program key> <binary>
  id=$(solana-keygen pubkey "$1")
  tmp=$(mktemp)
  if solana program dump -k "$KEY" -u "$RPC" "$id" "$tmp" >/dev/null 2>&1 && [ "$(head -c "$(stat -c %s "$2")" "$tmp" | sha256sum | cut -d' ' -f1)" = "$(sha256sum "$2" | cut -d' ' -f1)" ]; then
    echo "   $id is up to date"
  else
    echo "   deploying $2 to $id"
    solana program deploy -u "$RPC" -k "$KEY" --program-id "$1" --upgrade-authority "$KEY" "$2"
  fi
  rm -f "$tmp"
}
echo "== programs"
deploy keys/percolator-devnet-keypair.json "${PERCOLATOR_SO:-../percolator-prog/target/deploy/percolator_prog.so}"
deploy keys/percolator_vault-keypair.json target/deploy-x1/percolator_vault.so
deploy keys/router-keypair.json target/deploy-x1/percolator_router.so

echo "== reporter"
REPORTER=$(solana-keygen pubkey keys/reporter-keypair.json)
# The reporter pays the rent of each feed's price account (about 0.0014 XNT) the first time.
if [ "$(solana balance -u "$RPC" "$REPORTER" --lamports | cut -d' ' -f1)" -lt 50000000 ]; then
  solana transfer -u "$RPC" -k "$KEY" --allow-unfunded-recipient "$REPORTER" 0.2
fi

echo "== market"
if ! grep -q '"market"' "$MANIFEST" 2>/dev/null; then
  deploy/x1-tool setup-market
  deploy/x1-tool accept-governance
fi
# What the app, the executor and the scripts read. Only the real deployment's manifest goes
# into the app; a rehearsal passes its own to the scripts with MANIFEST_JSON="$(cat <manifest>)".
python3 - "$MANIFEST" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
keep = ["network", "percolator_program", "vault_program", "collateral_mint", "market", "percolator_vault", "percolator_vault_authority", "admin"]
if sys.argv[1] == "deploy/x1-testnet.json":
    json.dump({k: m[k] for k in keep}, open("app/src/x1-testnet.json", "w"), indent=2)
print("   market", m["market"], "test USDC", m["collateral_mint"])
PY
cat <<MSG

Done. Next, from app/ (each with NETWORK=x1-testnet, and RPC=$RPC if it is not X1 testnet):
  npx tsx scripts/executor.ts                      # prices, fills, liquidations (keep running)
  ../deploy/x1-tool keeper                         # from the repo root, with the same PERCOLATOR_* settings (keep running)
  ../deploy/x1-tool faucet <wallet> <usdc atoms>   # test USDC
  npx tsx scripts/launch-smoke.ts <keypair> SOL    # open the SOL market and deposit
MSG
