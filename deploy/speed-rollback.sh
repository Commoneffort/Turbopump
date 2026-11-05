#!/bin/sh
# Back to the version before the speed work (tag pre-speed-fork-2026-11-05, docs/SPEED-FORK.md)
# on X1 testnet, from the binaries saved on 2026-11-05 (~/percolator/backups/pre-speed-fork-2026-11-05,
# byte for byte what was on chain then):
#   1. the router (the services on the new code work with the old router too);
#   2. the services' code back to the tag (app/), and the X1 executors, bots and watchdog restarted;
#   3. the vault and the Percolator program.
# Requests queued under slot time cannot fill under the old router: they expire (their bonds are
# forfeited). Let the queue empty first if it matters.
#
#   deploy/speed-rollback.sh
set -e
cd "$(dirname "$0")/.."
B=$HOME/percolator/backups/pre-speed-fork-2026-11-05
L=deploy/logs
PROGRAM_SO=$B/exact-router.x1.so deploy/upgrade-program.sh router x1
git checkout pre-speed-fork-2026-11-05 -- app/scripts app/src app/api
below() { for c in $(pgrep -P "$1"); do below "$c"; echo "$c"; done; }
for s in x1-executor x1-backup-executor x1-bots x1-watchdog; do
  loop=$(cat "$L/$s.pid" 2>/dev/null) || continue
  kids=$(below "$loop"); [ -n "$kids" ] && kill $kids 2>/dev/null || true
  echo "restarted $s on the old code"
done
PROGRAM_SO=$B/exact-vault.x1.so deploy/upgrade-program.sh vault x1
PERCOLATOR_SO=$B/exact-engine.so deploy/upgrade-program.sh engine x1
echo "rolled back. The page: check out the tag in app/ and publish it (cd app && npm run build, then npx vercel --prod --yes)."
