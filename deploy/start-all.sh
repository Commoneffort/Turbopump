#!/bin/bash
# Starts everything after the machine has booted (crontab: @reboot). Each service keeps itself
# running from then on (see the restart loops in the service scripts); this only covers the one
# case they cannot: the machine itself going down. Safe to run at any time: what is already
# running is left alone.
#   deploy/start-all.sh        (its own output goes to deploy/logs/start-all.log)
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")/.."
mkdir -p deploy/logs
{
  echo "== $(date -u +%FT%TZ) start-all"
  [ "$1" = "--boot" ] && sleep 45 # let the network come up
  deploy/x1-services.sh start
  deploy/devnet-services.sh start
  deploy/local-services.sh start
  sleep 20
  deploy/bots.sh x1 start
  deploy/bots.sh devnet start
} >> deploy/logs/start-all.log 2>&1 < /dev/null
