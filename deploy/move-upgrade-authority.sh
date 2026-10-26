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
    now=$(solana program show -k "$KEY" -u $RPC $p | sed -n 's/^Authority: //p')
    if [ "$now" = "$NEW" ]; then echo "$net $p: already $NEW"; continue; fi
    # X1's RPC often answers "Blockhash not found" for a transaction sent right after it fetched
    # one: try again a few times, and check what the chain says after each try.
    for try in 1 2 3 4 5 6; do
      solana program set-upgrade-authority -u $RPC -k "$KEY" $p --upgrade-authority "$KEY" --new-upgrade-authority "$U" >/dev/null 2>&1 || true
      now=$(solana program show -k "$KEY" -u $RPC $p | sed -n 's/^Authority: //p')
      [ "$now" = "$NEW" ] && break
      echo "$net $p: not yet (try $try), again in 5 s"; sleep 5
    done
    [ "$now" = "$NEW" ] || { echo "$net $p: still $now after 6 tries; run this again later"; exit 1; }
    echo "$net $p: $now"
  done
done
