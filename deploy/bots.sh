#!/bin/bash
# Starts, stops or shows the trading bots of one test network (app/scripts/bots.ts): seven
# labelled test wallets that trade, place every kind of standing order, and check the markets on
# every pass. They send transactions and pay test coins for them (fees, and each order's bond,
# which our own executor earns back). The bots top themselves up from the deploy wallet.
#   deploy/bots.sh x1|devnet start | stop | status | report [hours] | failures
#   BOT_PACE_SECS=240 to change the pace, BOT_SYMBOLS=SOL,BTC to change the markets traded
#   BOT_SKIP=bot-a,bot-b to leave bots out. On X1 the max-leverage bots are left out by default: their
#   orders mostly expire, and each expired order forfeits up to 5 XNT (about 90% of X1 bot spending).
#   Since 2026-10-28 scalper and random are left out on both networks (to save fees: every open
#   position is settled on every price move; trend, fade and cross cover the same paths), and X1
#   bots trade every 360 s instead of 240. BOT_SKIP= (empty) runs them all.
cd "$(dirname "$0")/.."
case "$1" in
  x1)     NET=x1-testnet; NAME=x1-bots; RPC=${X1_RPC:-https://rpc.testnet.x1.xyz}; SYMBOLS=${BOT_SYMBOLS:-SOL,BTC,ETH}; PACE=${BOT_PACE_SECS:-360}; SKIP=${BOT_SKIP-bot-edge-long,bot-edge-short,bot-max,bot-scalper,bot-random} ;;
  devnet) NET=devnet; NAME=devnet-bots; RPC=${DEVNET_RPC:-$(cat ~/.config/percolator/devnet-rpc 2>/dev/null || echo https://api.devnet.solana.com)}; SYMBOLS=${BOT_SYMBOLS:-SOL,BTC,ETH}; PACE=${BOT_PACE_SECS:-600}; SKIP=${BOT_SKIP-bot-scalper,bot-random} ;;
  *) echo "usage: $0 x1|devnet start | stop | status | report [hours] | failures"; exit 1 ;;
esac
mkdir -p deploy/logs
PID=deploy/logs/$NAME.pid
running() { [ -f $PID ] && kill -0 -- "-$(cat $PID)" 2>/dev/null; }
# The xDEX swap bots (app/scripts/swap-bots.ts) run beside the trading bots, in their own loop.
SNAME=${NAME/bots/swap-bots}; SPID=deploy/logs/$SNAME.pid
srunning() { [ -f $SPID ] && kill -0 -- "-$(cat $SPID)" 2>/dev/null; }
case "$2" in
  start)
    if ! running; then
      (cd app && NETWORK=$NET RPC=$RPC BOT_PACE_SECS=$PACE BOT_SKIP=$SKIP setsid sh -c "echo \$\$ > ../$PID; while :; do npx tsx scripts/bots.ts run $SYMBOLS; echo \"\$(date -u +%T) restart: $NAME exited with status \$?, starting them again in 30 s\"; sleep 30; done" >> ../deploy/logs/$NAME.log 2>&1 < /dev/null &)
    fi
    if ! srunning; then
      (cd app && NETWORK=$NET RPC=$RPC setsid sh -c "echo \$\$ > ../$SPID; while :; do npx tsx scripts/swap-bots.ts run; echo \"\$(date -u +%T) restart: $SNAME exited with status \$?, starting them again in 30 s\"; sleep 30; done" >> ../deploy/logs/$SNAME.log 2>&1 < /dev/null &)
    fi
    sleep 2; "$0" "$1" status ;;
  stop)
    if running; then kill -- "-$(cat $PID)"; echo "$NAME stopped"; fi; rm -f $PID
    if srunning; then kill -- "-$(cat $SPID)"; echo "$SNAME stopped"; fi; rm -f $SPID ;;
  status)
    if running; then echo "$NAME running (process group $(cat $PID))"; else echo "$NAME not running"; fi
    if srunning; then echo "$SNAME running (process group $(cat $SPID))"; else echo "$SNAME not running"; fi ;;
  sweep) (cd app && NETWORK=$NET RPC=$RPC npx tsx scripts/bots.ts sweep 2>&1 | grep -v "punycode\|trace-deprecation") ;;
  report) (cd app && NETWORK=$NET npx tsx scripts/bots.ts report $3 2>&1 | grep -v "punycode\|trace-deprecation") ;;
  failures) grep -a "CHECK FAILED\|FAIL \|error" deploy/logs/$NAME.log deploy/logs/$SNAME.log | tail -${3:-40} ;;
  *) echo "usage: $0 x1|devnet start | stop | status | report [hours] | failures"; exit 1 ;;
esac
