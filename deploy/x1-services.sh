#!/bin/bash
# Starts, stops or shows the two X1 testnet services (executor and keeper). Each one's process
# group id is kept in deploy/logs/, so stopping never has to search the process list by name.
#   deploy/x1-services.sh start | stop | status
cd "$(dirname "$0")/.."
RPC=${X1_RPC:-https://rpc.testnet.x1.xyz}
KEY=${PERCOLATOR_KEYPAIR:-$HOME/.config/solana/percolator-x1/deployer.json}
mkdir -p deploy/logs
running() { [ -f "deploy/logs/$1.pid" ] && kill -0 -- "-$(cat "deploy/logs/$1.pid")" 2>/dev/null; }
case "$1" in
  start)
    if ! running x1-executor; then
      (cd app && NETWORK=x1-testnet RPC=$RPC KEYPAIR=$KEY setsid sh -c 'echo $$ > ../deploy/logs/x1-executor.pid; exec npx tsx scripts/executor.ts' > ../deploy/logs/x1-executor.log 2>&1 < /dev/null &)
    fi
    if ! running x1-keeper; then
      (PERCOLATOR_FIT_COMPUTE=1 PERCOLATOR_MANIFEST=deploy/x1-testnet.json PERCOLATOR_NETWORK=x1-testnet DEVNET_RPC=$RPC PERCOLATOR_KEYPAIR=$KEY PERCOLATOR_FAUCET_KEY=keys/x1-faucet.json \
        setsid sh -c 'echo $$ > deploy/logs/x1-keeper.pid; exec deploy/x1-tool keeper' > deploy/logs/x1-keeper.log 2>&1 < /dev/null &)
    fi
    sleep 2
    "$0" status
    ;;
  stop)
    for s in x1-executor x1-keeper; do
      if running $s; then kill -- "-$(cat deploy/logs/$s.pid)"; echo "$s stopped"; fi
      rm -f deploy/logs/$s.pid
    done
    ;;
  status)
    for s in x1-executor x1-keeper; do
      if running $s; then echo "$s running (process group $(cat deploy/logs/$s.pid))"; else echo "$s not running"; fi
    done
    ;;
  *) echo "usage: $0 start | stop | status"; exit 1 ;;
esac
