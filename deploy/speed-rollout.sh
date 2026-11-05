#!/bin/sh
# The speed rollout on X1 testnet (docs/SPEED-FORK.md), in the order that keeps trading working at
# every step:
#   1. the X1 executors, bots and watchdog restart on the new code (it detects which router it is
#      talking to, so it works with the old router until step 4);
#   2. the Percolator program with the engine fork (inert until a vault's matcher asks for it);
#   3. the vault program (reads the longer price accounts, passes the router's lazy flag on);
#   4. the router (slot time, lazy settlement): from its first price the services count in slots;
#   5. a look at the executor's log for slot-time prices and lazy fills.
# The page is published separately (cd app && npm run build, then npx vercel --prod --yes).
#
#   deploy/speed-rollout.sh            all steps
#   deploy/speed-rollout.sh from 3     from step 3 on (after a step that failed was fixed)
# Run deploy/release-check.sh on the commit checked out first (the upgrade script refuses
# anything else). To go back: deploy/speed-rollback.sh.
set -e
cd "$(dirname "$0")/.."
FROM=1; [ "$1" = from ] && FROM=$2
L=deploy/logs
step() { [ "$1" -ge "$FROM" ]; }
# Every process under a service's restart loop is stopped; the loop starts it again on the code
# checked out now. (The loop itself, and the price services, keep running.)
below() { for c in $(pgrep -P "$1"); do below "$c"; echo "$c"; done; }
restart() {
  loop=$(cat "$L/$1.pid" 2>/dev/null) || { echo "no $1 loop"; return; }
  kids=$(below "$loop"); [ -n "$kids" ] && kill $kids 2>/dev/null || true
  echo "restarted $1"
}
if step 1; then
  for s in x1-executor x1-backup-executor x1-bots x1-watchdog; do restart $s; done
  echo "waiting 90 s for the executor to come back and work"; sleep 90
  tail -5 $L/x1-executor.log
  grep -qE "^.{9}ok " $L/x1-executor.log || { echo "the executor logged nothing ok yet: look at $L/x1-executor.log before going on (then: $0 from 2)"; exit 1; }
fi
if step 2; then
  (cd ../percolator-prog && cargo build-sbf --tools-version v1.52 >/dev/null 2>&1)
  PERCOLATOR_SO=../percolator-prog/target/deploy/percolator_prog.so deploy/upgrade-program.sh engine x1
fi
step 3 && deploy/upgrade-program.sh vault x1
step 4 && deploy/upgrade-program.sh router x1
if step 5; then
  echo "watching the executor for 3 minutes (slot-time prices, lazy fills)"; sleep 180
  grep -E "price for slot|lazy fill|in one transaction|open the price range" $L/x1-executor.log | tail -8
  grep -cE "^.{9}fail" $L/x1-executor.log | sed 's/^/failed transactions in the log so far: /'
fi
