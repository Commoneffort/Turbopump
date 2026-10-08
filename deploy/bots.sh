#!/bin/bash
# Starts, stops or shows the trading bots of one test network (app/scripts/bots.ts): seven
# labelled test wallets that trade, place every kind of standing order, and check the markets on
# every pass. They send transactions and pay test coins for them (fees, and each order's bond,
# which our own executor earns back). The bots top themselves up from the deploy wallet.
#   deploy/bots.sh x1|devnet start | stop | status | report [hours] | failures
#   BOT_PACE_SECS=240 to change the pace, BOT_SYMBOLS=SOL,BTC to change the markets traded
cd "$(dirname "$0")/.."
case "$1" in
  x1)     NET=x1-testnet; NAME=x1-bots; RPC=${X1_RPC:-https://rpc.testnet.x1.xyz}; SYMBOLS=${BOT_SYMBOLS:-SOL,BTC,ETH}; PACE=${BOT_PACE_SECS:-240} ;;
  devnet) NET=devnet; NAME=devnet-bots; RPC=${DEVNET_RPC:-https://api.devnet.solana.com}; SYMBOLS=${BOT_SYMBOLS:-SOL,BTC,ETH}; PACE=${BOT_PACE_SECS:-600} ;;
  *) echo "usage: $0 x1|devnet start | stop | status | report [hours] | failures"; exit 1 ;;
esac
mkdir -p deploy/logs
PID=deploy/logs/$NAME.pid
running() { [ -f $PID ] && kill -0 -- "-$(cat $PID)" 2>/dev/null; }
case "$2" in
  start)
    if ! running; then
      (cd app && NETWORK=$NET RPC=$RPC BOT_PACE_SECS=$PACE setsid sh -c "echo \$\$ > ../$PID; while :; do npx tsx scripts/bots.ts run $SYMBOLS; echo \"\$(date -u +%T) restart: $NAME exited with status \$?, starting them again in 30 s\"; sleep 30; done" >> ../deploy/logs/$NAME.log 2>&1 < /dev/null &)
    fi
    sleep 2; "$0" "$1" status ;;
  stop) if running; then kill -- "-$(cat $PID)"; echo "$NAME stopped"; fi; rm -f $PID ;;
  status) if running; then echo "$NAME running (process group $(cat $PID))"; else echo "$NAME not running"; fi ;;
  report) (cd app && NETWORK=$NET npx tsx scripts/bots.ts report $3 2>&1 | grep -v "punycode\|trace-deprecation") ;;
  failures) grep -a "CHECK FAILED\|FAIL \|error" deploy/logs/$NAME.log | tail -${3:-40} ;;
  *) echo "usage: $0 x1|devnet start | stop | status | report [hours] | failures"; exit 1 ;;
esac
