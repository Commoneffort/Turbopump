#!/bin/bash
# Starts, stops or shows the Solana devnet services (executor, keeper, and the watchdog that
# sends alerts: scripts/watchdog.ts). Each one's process
# group id is kept in deploy/logs/, so stopping never has to search the process list by name.
#   deploy/devnet-services.sh start | stop | status | restart-executor
# A service that exits (a crash, or the executor's own watchdog) is started again after 5 s;
# `stop` ends the restart loop with it.
cd "$(dirname "$0")/.."
RPC=${DEVNET_RPC:-https://api.devnet.solana.com}
mkdir -p deploy/logs
running() { [ -f "deploy/logs/$1.pid" ] && kill -0 -- "-$(cat "deploy/logs/$1.pid")" 2>/dev/null; }
stop() { if running $1; then kill -- "-$(cat deploy/logs/$1.pid)"; echo "$1 stopped"; fi; rm -f deploy/logs/$1.pid; }
case "$1" in
  start)
    if ! running devnet-executor; then
      (cd app && RPC=$RPC setsid sh -c 'echo $$ > ../deploy/logs/devnet-executor.pid; while :; do npx tsx scripts/executor.ts; echo "$(date -u +%T) restart: devnet-executor exited with status $?, starting it again in 5 s"; sleep 5; done' >> ../deploy/logs/executor.log 2>&1 < /dev/null &)
    fi
    if ! running devnet-watchdog; then
      (cd app && NETWORK=devnet RPC=$RPC setsid sh -c 'echo $$ > ../deploy/logs/devnet-watchdog.pid; while :; do npx tsx scripts/watchdog.ts; echo "$(date -u +%T) restart: devnet-watchdog exited with status $?, starting it again in 30 s"; sleep 30; done' >> ../deploy/logs/devnet-watchdog.log 2>&1 < /dev/null &)
    fi
    if ! running devnet-keeper; then
      (DEVNET_RPC=$RPC setsid sh -c 'echo $$ > deploy/logs/devnet-keeper.pid; while :; do deploy/devnet-tool keeper; echo "$(date -u +%T) restart: devnet-keeper exited with status $?, starting it again in 5 s"; sleep 5; done' >> deploy/logs/keeper.log 2>&1 < /dev/null &)
    fi
    sleep 2
    "$0" status
    ;;
  stop) stop devnet-executor; stop devnet-keeper; stop devnet-watchdog ;;
  restart-executor) stop devnet-executor; sleep 1; "$0" start ;;
  status)
    for s in devnet-executor devnet-keeper devnet-watchdog; do
      if running $s; then echo "$s running (process group $(cat deploy/logs/$s.pid))"; else echo "$s not running"; fi
    done
    ;;
  *) echo "usage: $0 start | stop | status | restart-executor"; exit 1 ;;
esac
