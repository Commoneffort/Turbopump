#!/bin/bash
# Starts, stops or shows the two Solana devnet services (executor and keeper). Each one's process
# group id is kept in deploy/logs/, so stopping never has to search the process list by name.
#   deploy/devnet-services.sh start | stop | status | restart-executor
cd "$(dirname "$0")/.."
RPC=${DEVNET_RPC:-https://api.devnet.solana.com}
mkdir -p deploy/logs
running() { [ -f "deploy/logs/$1.pid" ] && kill -0 -- "-$(cat "deploy/logs/$1.pid")" 2>/dev/null; }
stop() { if running $1; then kill -- "-$(cat deploy/logs/$1.pid)"; echo "$1 stopped"; fi; rm -f deploy/logs/$1.pid; }
case "$1" in
  start)
    if ! running devnet-executor; then
      (cd app && RPC=$RPC setsid sh -c 'echo $$ > ../deploy/logs/devnet-executor.pid; exec npx tsx scripts/executor.ts' >> ../deploy/logs/executor.log 2>&1 < /dev/null &)
    fi
    if ! running devnet-keeper; then
      (DEVNET_RPC=$RPC setsid sh -c 'echo $$ > deploy/logs/devnet-keeper.pid; exec deploy/devnet-tool keeper' >> deploy/logs/keeper.log 2>&1 < /dev/null &)
    fi
    sleep 2
    "$0" status
    ;;
  stop) stop devnet-executor; stop devnet-keeper ;;
  restart-executor) stop devnet-executor; sleep 1; "$0" start ;;
  status)
    for s in devnet-executor devnet-keeper; do
      if running $s; then echo "$s running (process group $(cat deploy/logs/$s.pid))"; else echo "$s not running"; fi
    done
    ;;
  *) echo "usage: $0 start | stop | status | restart-executor"; exit 1 ;;
esac
