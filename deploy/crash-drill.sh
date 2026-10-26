#!/bin/bash
# The crash drill: the X1 build of our three programs on a private local chain, a price service
# whose prices we set (app/scripts/fake-oracle.ts), and our own executor, keeper and bots against
# it. Then app/scripts/crash-drill.ts runs the price moves no live network shows (an 8% slide, a
# 10% squeeze, a 20% gap after a silence, the primary price service dying, a 6% spike, a 4-minute
# outage) and reports. Nothing here touches X1 testnet or devnet, and the live keeper tool and
# binaries are used as they are (nothing is rebuilt).
#
#   deploy/crash-drill.sh            the whole drill (~1.5 h), in the background; prints where the logs are
#   deploy/crash-drill.sh stop       stop everything it started
#   deploy/crash-drill.sh status     what is running, and the last lines of the driver's log
# Logs and the chain: deploy/logs/drill/ (driver.log is the one to read).
cd "$(dirname "$0")/.."
ROOT=$PWD
D=$ROOT/deploy/logs/drill
RPC=http://127.0.0.1:18899
mkdir -p "$D"
running() { [ -f "$D/$1.pid" ] && kill -0 -- "-$(cat "$D/$1.pid")" 2>/dev/null; }
stop_all() { for s in bots witness keeper executor oracle validator driver; do if running $s; then kill -- "-$(cat "$D/$s.pid")" 2>/dev/null; echo "$s stopped"; fi; rm -f "$D/$s.pid"; done; }
bg() { # <name> <dir> <command...>: runs in its own process group, pid file in $D
  local name=$1 dir=$2; shift 2
  (cd "$dir" && setsid sh -c "echo \$\$ > $D/$name.pid; exec $*" >> "$D/$name.log" 2>&1 < /dev/null &)
}
case "$1" in
  stop) stop_all; exit 0 ;;
  status) for s in validator oracle witness executor keeper bots driver; do running $s && echo "$s running" || echo "$s not running"; done; tail -15 "$D/driver.log" 2>/dev/null; exit 0 ;;
  inner) ;; # the drill itself (below), run in the background by the default case
  funding) # funding on and a crowd leaning long (see the funding step below)
    stop_all >/dev/null
    for i in $(seq 30); do ss -ltn | grep -qE ":(18899|19900|18001) " || break; sleep 1; done
    rm -rf "$D"/*; mkdir -p "$D"
    bg driver "$ROOT" env CROWD_FUNDING=1 CROWD=${CROWD:-60} deploy/crash-drill.sh inner
    echo "funding drill started; follow it with: tail -f $D/driver.log   (deploy/crash-drill.sh status | stop)"
    exit 0 ;;
  load) # throughput: trades at rising rates while more and more accounts hold positions
    stop_all >/dev/null
    for i in $(seq 30); do ss -ltn | grep -qE ":(18899|19900|18001) " || break; sleep 1; done
    rm -rf "$D"/*; mkdir -p "$D"
    bg driver "$ROOT" env LOAD=1 LOAD_CROWDS=${LOAD_CROWDS:-60,240} LOAD_RATES=${LOAD_RATES:-1,3,6,12} deploy/crash-drill.sh inner
    echo "load drill started; follow it with: tail -f $D/driver.log   (deploy/crash-drill.sh status | stop)"
    exit 0 ;;
  crowd) # a crowd of accounts instead of the bots and scenarios (see the crowd step below)
    stop_all >/dev/null
    for i in $(seq 30); do ss -ltn | grep -qE ":(18899|19900|18001) " || break; sleep 1; done
    rm -rf "$D"/*; mkdir -p "$D"
    bg driver "$ROOT" env CROWD=${CROWD:-100} CROWD_GAP=${CROWD_GAP:-1} deploy/crash-drill.sh inner
    echo "crowd drill started; follow it with: tail -f $D/driver.log   (deploy/crash-drill.sh status | stop)"
    exit 0 ;;
  *)
    stop_all >/dev/null
    # A validator just stopped keeps its ports for a few seconds.
    for i in $(seq 30); do ss -ltn | grep -qE ":(18899|19900|18001) " || break; sleep 1; done
    rm -rf "$D"/*; mkdir -p "$D"
    bg driver "$ROOT" deploy/crash-drill.sh inner
    echo "drill started; follow it with: tail -f $D/driver.log   (deploy/crash-drill.sh status | stop)"
    exit 0 ;;
esac

set -e
say() { echo "$(date -u +%T) $*"; }
KEY=$D/deployer.json
solana-keygen new --no-bip39-passphrase --silent --force -o "$KEY" >/dev/null
ME=$(solana-keygen pubkey "$KEY")
PERC_SO=${PERCOLATOR_SO:-../percolator-prog/target/deploy/percolator_prog.so}

say "== local chain on $RPC (programs: the X1 builds in target/deploy-x1 and $PERC_SO)"
bg validator "$D" solana-test-validator --reset --quiet --ledger "$D/ledger" --rpc-port 18899 --faucet-port 19900 --gossip-port 18001 --dynamic-port-range 18002-18040 \
  --upgradeable-program "$(solana-keygen pubkey keys/percolator-devnet-keypair.json)" "$ROOT/$PERC_SO" "$ME" \
  --upgradeable-program "$(solana-keygen pubkey keys/percolator_vault-keypair.json)" "$ROOT/target/deploy-x1/percolator_vault.so" "$ME" \
  --upgradeable-program "$(solana-keygen pubkey keys/router-keypair.json)" "$ROOT/target/deploy-x1/percolator_router.so" "$ME"
for i in $(seq 60); do solana cluster-version -u $RPC >/dev/null 2>&1 && break; running validator || { say "the local chain did not start:"; cat "$D/validator.log"; exit 1; }; sleep 2; done
solana airdrop -u $RPC 100000 "$ME" >/dev/null
solana airdrop -u $RPC 1000 "$(solana-keygen pubkey keys/reporter-keypair.json)" >/dev/null
say "deploy key $ME: $(solana balance -u $RPC "$ME")"

export PERCOLATOR_MANIFEST=$D/manifest.json PERCOLATOR_NETWORK=x1-testnet DEVNET_RPC=$RPC PERCOLATOR_KEYPAIR=$KEY PERCOLATOR_FAUCET_KEY=$KEY PERCOLATOR_FIT_COMPUTE=1
echo '{}' > "$D/manifest.json"
say "== market"
deploy/x1-tool setup-market
deploy/x1-tool accept-governance
MINT=$(python3 -c "import json;print(json.load(open('$D/manifest.json'))['collateral_mint'])")
spl-token create-account "$MINT" --owner B9Ke1KTC8x46ZxAMTa7oU73HXEzPXt17GC7bZujxiiWV --fee-payer "$KEY" -u $RPC >/dev/null
ACC=$(spl-token address --token "$MINT" --owner B9Ke1KTC8x46ZxAMTa7oU73HXEzPXt17GC7bZujxiiWV --verbose -u $RPC | awk '/Associated token address/ {print $NF}')
python3 - "$D/manifest.json" "$ACC" <<'PY'
import json, sys
m = json.load(open(sys.argv[1])); m["treasury_collateral"] = sys.argv[2]
json.dump(m, open(sys.argv[1], "w"), indent=2)
PY
export MANIFEST_JSON="$(cat "$D/manifest.json")"

say "== price service (fake: primary :18090, backup :18091), executor, keeper"
bg oracle "$ROOT/app" npx tsx scripts/fake-oracle.ts
COMMON="NETWORK=x1-testnet RPC=$RPC KEYPAIR=$KEY"
bg executor "$ROOT/app" env $COMMON JACK_URLS=http://127.0.0.1:18090,http://127.0.0.1:18091 npx tsx scripts/executor.ts
bg keeper "$ROOT" deploy/x1-tool keeper
# The X1 router moves a mark only with the witness's agreement: the witness reads the backup port.
solana airdrop -u $RPC 1000 "$(solana-keygen pubkey keys/witness-keypair.json)" >/dev/null
bg witness "$ROOT/app" env NETWORK=x1-testnet RPC=$RPC WITNESS_PRICES=http://127.0.0.1:18091 npx tsx scripts/witness.ts
DRILL="env $COMMON BOT_LOG=$D/bots.jsonl EXEC_LOG=$D/executor.log ORACLE_CONTROL=http://127.0.0.1:18090"

say "== markets and liquidity"
(cd app && $DRILL FAUCET_KEY=$KEY npx tsx scripts/open-markets.ts SOL,BTC,ETH ${DRILL_SEED:-30000})
(cd app && $DRILL npx tsx scripts/crash-drill.ts ready)

if [ -n "$LOAD" ]; then
  # The load drill (deploy/crash-drill.sh load): for each crowd size in LOAD_CROWDS (accounts holding
  # positions, added on top of the last), $25 trades at each rate in LOAD_RATES for 30 s.
  have=0
  for n in ${LOAD_CROWDS//,/ }; do
    say "== crowd: $((n - have)) more accounts (total $n)"
    (cd app && $DRILL npx tsx scripts/crowd.ts open "$((n - have))" ${CROWD_USDC:-200} ${CROWD_LEV:-4} 2>&1 | grep -v -i deprecat | tail -2)
    have=$n
    for r in ${LOAD_RATES//,/ }; do
      (cd app && $DRILL npx tsx scripts/crowd.ts load "$r" 30 25 2>&1 | grep -v -i deprecat)
      sleep 20
    done
  done
  say "== executor transactions during the drill"
  grep -cE "^.{9}ok " "$D/executor.log" || true
  say "load drill finished; everything is still running for a look (deploy/crash-drill.sh stop)"
  exit 0
fi

if [ -n "$CROWD_FUNDING" ]; then
  # The funding drill (deploy/crash-drill.sh funding): funding on, a crowd leaning long, then the
  # rates and the crowd's equity every minute for 15 minutes (prices stand still: what the crowd
  # loses is the funding it pays).
  say "== funding on"
  (cd app && $DRILL npx tsx scripts/crowd.ts funding-on)
  say "== crowd: ${CROWD:-60} accounts"
  (cd app && $DRILL CROWD_LONG=0.8 npx tsx scripts/crowd.ts open "${CROWD:-60}" ${CROWD_USDC:-200} ${CROWD_LEV:-8})
  for i in $(seq 15); do
    (cd app && $DRILL npx tsx scripts/crowd.ts funding 2>&1 | grep -v -i deprecat)
    (cd app && $DRILL npx tsx scripts/crowd.ts equity 2>&1 | grep -v -i deprecat)
    sleep 60
  done
  say "funding drill finished; everything is still running for a look (deploy/crash-drill.sh stop)"
  exit 0
fi

if [ -n "$CROWD" ]; then
  # The crowd drill (deploy/crash-drill.sh crowd): CROWD accounts with leveraged positions, then an
  # 8% slide over two minutes and, once that has settled, a 30% gap.
  say "== crowd: $CROWD accounts"
  (cd app && $DRILL npx tsx scripts/crowd.ts open "$CROWD" ${CROWD_USDC:-200} ${CROWD_LEV:-8})
  say "== crowd: slide -8% over 2 minutes"
  (cd app && $DRILL npx tsx scripts/crowd.ts crash -8 120 600)
  if [ "${CROWD_GAP:-1}" != 0 ]; then
    say "== crowd: positions again, then a gap: 30% lower in 5 seconds"
    (cd app && $DRILL npx tsx scripts/crowd.ts open "$CROWD" ${CROWD_USDC:-200} ${CROWD_LEV:-8})
    (cd app && $DRILL npx tsx scripts/crowd.ts crash -30 5 600)
  fi
  say "== money (Percolator's totals)"
  (cd app && env $COMMON npx tsx scripts/pnl.ts 2>&1 | grep -v "punycode\|trace-deprecation" | head -30) || true
  say "crowd drill finished; everything is still running for a look (deploy/crash-drill.sh stop)"
  exit 0
fi

say "== bots (fast pace; the whale every half hour)"
bg bots "$ROOT/app" $DRILL FAUCET_KEY=$KEY BOT_NO_EXCHANGE=1 BOT_PACE_SECS=${DRILL_PACE:-60} WHALE_HOURS=0.5 WHALE_FIRST_MIN=1 WHALE_SHARE=0.5 npx tsx scripts/bots.ts run SOL,BTC,ETH

say "== scenarios"
(cd app && $DRILL npx tsx scripts/crash-drill.ts run)
say "== bots' report"
(cd app && $DRILL npx tsx scripts/bots.ts report 2>&1 | grep -v "punycode\|trace-deprecation")
say "== money (Percolator's totals; 'in no account' should not grow)"
(cd app && env $COMMON npx tsx scripts/pnl.ts 2>&1 | grep -v "punycode\|trace-deprecation" | head -30) || true
say "drill finished; everything is still running for a look (deploy/crash-drill.sh stop)"
