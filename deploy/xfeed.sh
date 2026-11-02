#!/bin/bash
# Starts, stops or shows the X feed collector (app/scripts/xfeed-collector.ts): reads the accounts
# in deploy/xfeed-handles.txt one every 40 s and serves them on :8788/xfeed.json, where the site's
# /api/xfeed reads them (Vercel env XFEED_URL=http://<this machine>:8788).
#   deploy/xfeed.sh start | stop | status | restart
cd "$(dirname "$0")/.."
mkdir -p deploy/logs
PID=deploy/logs/xfeed.pid
running() { [ -f $PID ] && kill -0 -- "-$(cat $PID)" 2>/dev/null; }
case "$1" in
  start) running || (cd app && setsid sh -c "echo \$\$ > ../$PID; while :; do npx tsx scripts/xfeed-collector.ts; echo \"\$(date -u +%T) restart: collector exited with status \$?, starting again in 60 s\"; sleep 60; done" >> ../deploy/logs/xfeed.log 2>&1 < /dev/null &); sleep 2; "$0" status ;;
  stop) if running; then kill -- "-$(cat $PID)"; echo "xfeed stopped"; fi; rm -f $PID ;;
  restart) "$0" stop; sleep 1; "$0" start ;;
  status) if running; then echo "xfeed running (process group $(cat $PID))"; else echo "xfeed not running"; fi ;;
  *) echo "usage: $0 start | stop | status | restart"; exit 1 ;;
esac
