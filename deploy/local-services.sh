#!/bin/bash
# Starts, stops or shows the services that only read and cost nothing: the candle indexer, the two
# shadow hedgers (paper hedges of the Solana devnet and X1 testnet vaults; no venue, no money, no
# transaction) and the operator's hedge dashboard. All of them listen on this machine only.
#   deploy/local-services.sh start | stop | status
#   indexer   http://127.0.0.1:8791     hedge dashboard   http://127.0.0.1:8792
cd "$(dirname "$0")/.."
ROOT=$PWD
mkdir -p deploy/logs
SERVICES="indexer hedge-devnet hedge-x1 hedge-dashboard"
running() { [ -f "deploy/logs/$1.pid" ] && kill -0 -- "-$(cat "deploy/logs/$1.pid")" 2>/dev/null; }
launch() { # name, directory, command
  running "$1" && return
  (cd "$2" && setsid sh -c "echo \$\$ > $ROOT/deploy/logs/$1.pid; exec $3" > "$ROOT/deploy/logs/$1.log" 2>&1 < /dev/null &)
}
case "$1" in
  start)
    launch indexer app "npx tsx scripts/indexer.ts"
    for n in devnet x1; do (cd hedging && npx tsx src/cli/switch.ts on --state state/shadow-$n > /dev/null 2>&1); done
    launch hedge-devnet hedging "npx tsx src/cli/hedger.ts --venue mock --state state/shadow-devnet"
    RPC=${X1_RPC:-https://rpc.testnet.x1.xyz} launch hedge-x1 hedging "npx tsx src/cli/hedger.ts --venue mock --state state/shadow-x1 --deployment ../app/src/x1-testnet.json --config config/x1.json"
    launch hedge-dashboard hedging "npx tsx src/cli/dashboard.ts --port 8792"
    sleep 3
    "$0" status
    ;;
  stop)
    for s in $SERVICES; do
      if running $s; then kill -- "-$(cat deploy/logs/$s.pid)"; echo "$s stopped"; fi
      rm -f deploy/logs/$s.pid
    done
    ;;
  status)
    for s in $SERVICES; do
      if running $s; then echo "$s running (process group $(cat deploy/logs/$s.pid))"; else echo "$s not running"; fi
    done
    ;;
  *) echo "usage: $0 start | stop | status"; exit 1 ;;
esac
