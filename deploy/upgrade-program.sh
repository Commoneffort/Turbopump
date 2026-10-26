#!/bin/sh
# Builds and upgrades one of our programs on one test network, extending its account first when
# the new build is larger, then checks that what is on chain is the build byte for byte.
#
#   deploy/upgrade-program.sh router|vault|engine x1|devnet
#
# "engine" is Percolator itself (percolator-prog). It is not built here: it is uploaded from
# PERCOLATOR_SO (default ../percolator-prog/target/deploy/percolator_prog.so), which has to be
# built beforehand with `cargo build-sbf --tools-version v1.52` in percolator-prog (that toolchain
# reproduces the deployed binary byte for byte; v1.53 does not) and replay-tested on saved copies
# of the live markets (app/scripts/snapshot.ts + percolator-prog/tests/replay_x1.rs).
#
# The upgrade is signed by the programs' upgrade key, ~/.config/solana/percolator-upgrade.json
# (UPGRADE_KEY to change it), kept apart from the deploy wallet that pays the executor's fees: a
# leak of the services' key no longer hands over the programs. Until that key holds the authority
# the deploy wallet signs, as before. The deploy wallet pays.
# Run ./test.sh first if the code changed since it last passed. Requests, orders and vaults keep
# working across the upgrade (no account changed size).
set -e
cd "$(dirname "$0")/.."
case "$2" in
  x1)     RPC=${X1_RPC:-https://rpc.testnet.x1.xyz}; KEY=$HOME/.config/solana/percolator-x1/deployer.json; FEATURES=devnet,x1; OUT=target/deploy-x1 ;;
  devnet) RPC=${DEVNET_RPC:-$(cat ~/.config/percolator/devnet-rpc 2>/dev/null || echo https://api.devnet.solana.com)}; KEY=$HOME/.config/solana/percolator-test/deployer.json; FEATURES=devnet; OUT=target/deploy-devnet ;;
  *) echo "usage: $0 router|vault|engine x1|devnet"; exit 1 ;;
esac
case "$1" in
  router) ID=DkK9TSMpVXLq26HeqxTXLysXyRKDYHTKU94SLFDWgjw3; PKEY=keys/router-keypair.json; SO=$OUT/percolator_router.so
          (cd router && cargo build-sbf --tools-version v1.53 --features $FEATURES --sbf-out-dir ../$OUT >/dev/null 2>&1 || cargo build-sbf --tools-version v1.53 --features $FEATURES --sbf-out-dir ../$OUT) ;;
  vault)  ID=BSync6F8gtJs3Wj4w8L6H3ZtS397w2XoCYGEAJGmeYX; PKEY=keys/percolator_vault-keypair.json; SO=$OUT/percolator_vault.so
          cargo build-sbf --tools-version v1.53 --features $FEATURES --sbf-out-dir $OUT >/dev/null 2>&1 || cargo build-sbf --tools-version v1.53 --features $FEATURES --sbf-out-dir $OUT ;;
  engine) ID=8o3uV87X2CvPYfPwM1sxeaYYE7sGWsTUiEy7SskEMM3P; PKEY=keys/percolator-devnet-keypair.json; SO=${PERCOLATOR_SO:-../percolator-prog/target/deploy/percolator_prog.so} ;;
  *) echo "usage: $0 router|vault|engine x1|devnet"; exit 1 ;;
esac
# Already live (a rerun after a step that failed further on): nothing to upload.
live=$(mktemp)
if solana program dump -k "$KEY" -u "$RPC" $ID "$live" >/dev/null 2>&1 && [ "$(head -c "$(stat -c %s "$SO")" "$live" | sha256sum | cut -d' ' -f1)" = "$(sha256sum "$SO" | cut -d' ' -f1)" ]; then
  rm -f "$live"; echo "$1 on $2: this build is already live"; exit 0
fi
rm -f "$live"
UPGRADE=${UPGRADE_KEY:-$HOME/.config/solana/percolator-upgrade.json}
AUTH=$(solana program show -k "$KEY" -u "$RPC" $ID | sed -n 's/^Authority: //p')
# (Every solana call names a key: this server has no default ~/.config/solana/id.json any more,
# and without one the lookup above came back empty and the wrong key signed.)
[ -n "$AUTH" ] || { echo "could not read the upgrade authority of $ID on $RPC"; exit 1; }
if [ -f "$UPGRADE" ] && [ "$AUTH" = "$(solana-keygen pubkey "$UPGRADE")" ]; then SIGNER=$UPGRADE; else SIGNER=$KEY; fi
have=$(solana program show -k "$KEY" -u "$RPC" $ID | sed -n 's/^Data Length: \([0-9]*\).*/\1/p')
need=$(stat -c %s "$SO")
echo "$1 on $RPC: $have bytes deployed, the new build is $need (upgrade signed by $(solana-keygen pubkey "$SIGNER"))"
SIGNER_PK=$(solana-keygen pubkey "$SIGNER")
if [ "$need" -gt "$have" ]; then
  # (Solana refuses to extend a program by less than 10,240 bytes.) The extension is signed by the
  # program's upgrade authority and paid by it: give it the rent first when it is not the deploy
  # wallet (the upgrade key holds nothing of its own).
  more=$((need - have + 8192)); [ "$more" -lt 10240 ] && more=10240
  if [ "$SIGNER" != "$KEY" ]; then
    rent=$(solana rent -k "$KEY" -u "$RPC" $more 2>/dev/null | sed -n 's/^Rent-exempt minimum: \([0-9.]*\).*/\1/p')
    solana transfer -u "$RPC" -k "$KEY" --allow-unfunded-recipient "$SIGNER_PK" "$(python3 -c "print(round(${rent:-0.1} + 0.01, 6))")" >/dev/null
  fi
  solana program extend -u "$RPC" -k "$SIGNER" $ID $more
fi
# Through plain RPC (the CLI's direct send path is refused by the public devnet RPC), into a buffer
# whose key is kept until the upgrade went through: an upload cut off half-way (devnet rate limits)
# resumes where it stopped when this is run again, instead of stranding its rent. The deploy wallet
# pays for the buffer; the buffer's authority is the program's upgrade authority, which the loader
# requires for the upgrade (a buffer left from before the authority moved is handed over first).
BUF=deploy/logs/upgrade-buffer-$1-$2.json
mkdir -p deploy/logs
[ -f "$BUF" ] || solana-keygen new --no-bip39-passphrase --silent -o "$BUF" >/dev/null
BUF_PK=$(solana-keygen pubkey "$BUF")
buf_auth=$(solana program show -k "$KEY" -u "$RPC" "$BUF_PK" 2>/dev/null | sed -n 's/^Authority: //p')
if [ -n "$buf_auth" ] && [ "$buf_auth" != "$SIGNER_PK" ]; then
  solana program set-buffer-authority -u "$RPC" -k "$KEY" "$BUF_PK" --buffer-authority "$KEY" --new-buffer-authority "$SIGNER_PK" >/dev/null
fi
if [ "$2" = devnet ] && [ -z "$FAST_UPLOAD" ]; then
  # The public devnet RPC blocks this server for minutes after the CLI's burst of uploads: a
  # throttled upload instead (only missing pieces are sent; rerun it until the buffer matches).
  (cd app && RPC=$RPC npx tsx scripts/write-buffer.ts "../$BUF" "../$SO" "$SIGNER") | tail -3
  (cd app && RPC=$RPC npx tsx scripts/write-buffer.ts "../$BUF" "../$SO" "$SIGNER") | grep -q "buffer matches binary" || { echo "upload not finished: run this again to continue"; exit 1; }
else
  solana program write-buffer -u "$RPC" -k "$KEY" --use-rpc --max-sign-attempts 50 --buffer "$BUF" --buffer-authority "$SIGNER" "$SO"
fi
solana program upgrade -u "$RPC" -k "$KEY" "$BUF_PK" $ID --upgrade-authority "$SIGNER"
rm -f "$BUF"
tmp=$(mktemp)
solana program dump -k "$KEY" -u "$RPC" $ID "$tmp" >/dev/null
if [ "$(head -c "$need" "$tmp" | sha256sum | cut -d' ' -f1)" = "$(sha256sum "$SO" | cut -d' ' -f1)" ]; then echo "on chain = $SO"; else echo "WARNING: what is on chain differs from $SO"; fi
rm -f "$tmp"
