#!/bin/bash
# One-time: hands the upgrade rights of our three programs (router, vault, Percolator) on both test
# networks from the deploy wallets (which also pay the executor's fees and sit on this server for
# the services) to a key of their own, ~/.config/solana/percolator-upgrade.json. After this, a
# leak of a deploy wallet no longer lets anyone replace the programs.
#
#   deploy/move-upgrade-authority.sh
#
# Keep a copy of that key somewhere off this server (and remove it from here between upgrades if
# you like: deploy/upgrade-program.sh only needs it while upgrading). Without it the programs can
# never be upgraded again. A copy is in ~/.config/solana/backup/.
set -e
U=$HOME/.config/solana/percolator-upgrade.json
[ -f "$U" ] || { echo "no $U"; exit 1; }
[ -f "$HOME/.config/solana/backup/percolator-upgrade.json" ] || { echo "no backup copy of the upgrade key in ~/.config/solana/backup/"; exit 1; }
NEW=$(solana-keygen pubkey "$U")
echo "new upgrade authority: $NEW"
for net in x1 devnet; do
  case $net in
    x1)     RPC=https://rpc.testnet.x1.xyz; KEY=$HOME/.config/solana/percolator-x1/deployer.json ;;
    devnet) RPC=${DEVNET_RPC:-$(cat ~/.config/percolator/devnet-rpc 2>/dev/null || echo https://api.devnet.solana.com)}; KEY=$HOME/.config/solana/percolator-test/deployer.json ;;
  esac
  for p in DkK9TSMpVXLq26HeqxTXLysXyRKDYHTKU94SLFDWgjw3 BSync6F8gtJs3Wj4w8L6H3ZtS397w2XoCYGEAJGmeYX 8o3uV87X2CvPYfPwM1sxeaYYE7sGWsTUiEy7SskEMM3P; do
    now=$(solana program show -u $RPC $p | sed -n 's/^Authority: //p')
    if [ "$now" = "$NEW" ]; then echo "$net $p: already $NEW"; continue; fi
    solana program set-upgrade-authority -u $RPC -k "$KEY" $p --upgrade-authority "$KEY" --new-upgrade-authority "$U" >/dev/null
    echo "$net $p: $(solana program show -u $RPC $p | sed -n 's/^Authority: //p')"
  done
done
