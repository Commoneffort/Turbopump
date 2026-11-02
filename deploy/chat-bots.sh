#!/bin/bash
# Starts, stops or shows the market message bots of one test network (app/scripts/chat-bots.ts):
# our labelled bot wallets post a short message about SOL, BTC or ETH every ~25 minutes (network fee only).
#   deploy/chat-bots.sh x1|devnet start | stop | status | once [SYMBOL]
#   CHAT_PACE_SECS=1500 to change the pace, CHAT_SYMBOLS=SOL,BTC,ETH to change the markets
cd "$(dirname "$0")/.."
case "$1" in
  x1)     NET=x1-testnet; NAME=x1-chat-bots ;;
  devnet) NET=devnet; NAME=devnet-chat-bots ;;
  *) echo "usage: $0 x1|devnet start | stop | status | once [SYMBOL]"; exit 1 ;;
esac
mkdir -p deploy/logs
PID=deploy/logs/$NAME.pid
running() { [ -f $PID ] && kill -0 -- "-$(cat $PID)" 2>/dev/null; }
case "$2" in
  start)
    running || (cd app && NETWORK=$NET CHAT_PACE_SECS=${CHAT_PACE_SECS:-1500} setsid sh -c "echo \$\$ > ../$PID; while :; do npx tsx scripts/chat-bots.ts run ${CHAT_SYMBOLS:-SOL,BTC,ETH}; echo \"\$(date -u +%T) restart: $NAME exited with status \$?, starting again in 60 s\"; sleep 60; done" >> ../deploy/logs/$NAME.log 2>&1 < /dev/null &)
    sleep 2; "$0" "$1" status ;;
  stop) if running; then kill -- "-$(cat $PID)"; echo "$NAME stopped"; fi; rm -f $PID ;;
  status) if running; then echo "$NAME running (process group $(cat $PID))"; else echo "$NAME not running"; fi ;;
  once) (cd app && NETWORK=$NET npx tsx scripts/chat-bots.ts once $3 2>&1 | grep -v "punycode\|trace-deprecation") ;;
  *) echo "usage: $0 x1|devnet start | stop | status | once [SYMBOL]"; exit 1 ;;
esac
