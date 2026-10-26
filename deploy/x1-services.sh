#!/bin/bash
# Starts, stops or shows the X1 testnet services: our backup price service (127.0.0.1:8091, the
# executor's second source after jack0.x1.xyz), a second one on other exchanges for the witness
# (127.0.0.1:8092), the price witness, the fill log for payouts, the watchdog (alerts, scripts/watchdog.ts), the
# executor and the keeper. Each one's process
# group id is kept in deploy/logs/, so stopping never has to search the process list by name.
#   deploy/x1-services.sh start | stop | status
# A service that exits (a crash, or the executor's own watchdog) is started again after 5 s;
# `stop` ends the restart loop with it. The logs are appended to, so a restart keeps what
# happened before it.
cd "$(dirname "$0")/.."
RPC=${X1_RPC:-https://rpc.testnet.x1.xyz}
KEY=${PERCOLATOR_KEYPAIR:-$HOME/.config/solana/percolator-x1/deployer.json}
mkdir -p deploy/logs
# The witness runs on another machine once this file exists (docs: "Run the Turbopump price witness
# on another machine"); then this server starts neither the witness nor its price source.
[ -f "$HOME/.config/percolator/witness-elsewhere" ] && NO_WITNESS=1
running() { [ -f "deploy/logs/$1.pid" ] && kill -0 -- "-$(cat "deploy/logs/$1.pid")" 2>/dev/null; }
case "$1" in
  start)
    if ! running price-service; then
      (cd app && PORT=8091 EXCHANGES=coinbase,kraken,okx,bybit,kucoin SYMBOLS=${PRICE_SYMBOLS:-BTC,ETH,SOL} setsid sh -c 'echo $$ > ../deploy/logs/price-service.pid; while :; do npx tsx scripts/price-service.ts; echo "$(date -u +%T) restart: price-service exited with status $?, starting it again in 5 s"; sleep 5; done' >> ../deploy/logs/price-service.log 2>&1 < /dev/null &)
    fi
    # The witness's own price source (127.0.0.1:8092): exchanges the one above does not read, so the
    # reporter and the witness never read the same prices, even while jack0.x1.xyz is down.
    if [ -z "$NO_WITNESS" ] && ! running price-witness-source; then
      (cd app && PORT=8092 EXCHANGES=bitstamp,gemini,bitfinex,mexc SYMBOLS=${PRICE_SYMBOLS:-BTC,ETH,SOL} setsid sh -c 'echo $$ > ../deploy/logs/price-witness-source.pid; while :; do npx tsx scripts/price-service.ts; echo "$(date -u +%T) restart: price-witness-source exited with status $?, starting it again in 5 s"; sleep 5; done' >> ../deploy/logs/price-witness-source.log 2>&1 < /dev/null &)
    fi
    # The price witness (scripts/witness.ts): its own key and price source; the router takes an
    # X1 mark only with its price. Better run on another machine (set NO_WITNESS=1 here then).
    if [ -z "$NO_WITNESS" ] && ! running x1-witness; then
      (cd app && NETWORK=x1-testnet RPC=$RPC setsid sh -c 'echo $$ > ../deploy/logs/x1-witness.pid; while :; do npx tsx scripts/witness.ts; echo "$(date -u +%T) restart: x1-witness exited with status $?, starting it again in 5 s"; sleep 5; done' >> ../deploy/logs/x1-witness.log 2>&1 < /dev/null &)
    fi
    # Telegram alerts for traders (scripts/alerts-bot.ts: /watch <wallet>; reads only, no keys).
    if ! running x1-alerts; then
      (cd app && NETWORK=x1-testnet RPC=$RPC setsid sh -c 'echo $$ > ../deploy/logs/x1-alerts.pid; while :; do npx tsx scripts/alerts-bot.ts; echo "$(date -u +%T) restart: x1-alerts exited with status $?, starting it again in 30 s"; sleep 30; done' >> ../deploy/logs/x1-alerts.log 2>&1 < /dev/null &)
    fi
    if ! running x1-watchdog; then
      (cd app && NETWORK=x1-testnet RPC=$RPC KEYPAIR=$KEY setsid sh -c 'echo $$ > ../deploy/logs/x1-watchdog.pid; while :; do npx tsx scripts/watchdog.ts; echo "$(date -u +%T) restart: x1-watchdog exited with status $?, starting it again in 30 s"; sleep 30; done' >> ../deploy/logs/x1-watchdog.log 2>&1 < /dev/null &)
    fi
    # Every fill of every account, kept for the weekly payouts (scripts/fills-log.ts).
    if ! running x1-fills-log; then
      (cd app && NETWORK=x1-testnet RPC=$RPC setsid sh -c 'echo $$ > ../deploy/logs/x1-fills-log.pid; while :; do npx tsx scripts/fills-log.ts; echo "$(date -u +%T) restart: x1-fills-log exited with status $?, starting it again in 30 s"; sleep 30; done' >> ../deploy/logs/x1-fills-log.log 2>&1 < /dev/null &)
    fi
    if ! running x1-executor; then
      (cd app && NETWORK=x1-testnet RPC=$RPC KEYPAIR=$KEY setsid sh -c 'echo $$ > ../deploy/logs/x1-executor.pid; while :; do npx tsx scripts/executor.ts; echo "$(date -u +%T) restart: x1-executor exited with status $?, starting it again in 5 s"; sleep 5; done' >> ../deploy/logs/x1-executor.log 2>&1 < /dev/null &)
    fi
    if ! running x1-keeper; then
      (PERCOLATOR_FIT_COMPUTE=1 PERCOLATOR_MANIFEST=deploy/x1-testnet.json PERCOLATOR_NETWORK=x1-testnet DEVNET_RPC=$RPC PERCOLATOR_KEYPAIR=$KEY PERCOLATOR_FAUCET_KEY=keys/x1-faucet.json \
        setsid sh -c 'echo $$ > deploy/logs/x1-keeper.pid; while :; do deploy/x1-tool keeper; echo "$(date -u +%T) restart: x1-keeper exited with status $?, starting it again in 5 s"; sleep 5; done' >> deploy/logs/x1-keeper.log 2>&1 < /dev/null &)
    fi
    sleep 2
    "$0" status
    ;;
  stop)
    for s in price-service price-witness-source x1-witness x1-alerts x1-watchdog x1-fills-log x1-executor x1-keeper; do
      if running $s; then kill -- "-$(cat deploy/logs/$s.pid)"; echo "$s stopped"; fi
      rm -f deploy/logs/$s.pid
    done
    ;;
  status)
    for s in price-service price-witness-source x1-witness x1-alerts x1-watchdog x1-fills-log x1-executor x1-keeper; do
      if running $s; then echo "$s running (process group $(cat deploy/logs/$s.pid))"; else echo "$s not running"; fi
    done
    ;;
  *) echo "usage: $0 start | stop | status"; exit 1 ;;
esac
