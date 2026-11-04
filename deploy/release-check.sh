#!/bin/sh
# The release gate for our two programs (vault and router). It must pass before
# deploy/upgrade-program.sh uploads either one:
#   1. every change is committed (what goes on chain is a commit anyone can check out);
#   2. the whole suite passes on that commit (./test.sh: both programs, both builds);
#   3. each network's binaries are built twice from scratch and come out byte for byte the same
#      (a build that differs from itself cannot be checked against what is on chain);
#   4. their hashes are written to deploy/releases.log with the commit.
# upgrade-program.sh then uploads only a binary whose hash is in releases.log for the commit
# checked out, and afterwards checks that what is on chain is that binary.
#
#   deploy/release-check.sh            (about 10 minutes: tests, then 2 x 2 builds per network)
set -e
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "uncommitted changes: commit them first (the release is a commit)"; git status --short --untracked-files=no; exit 1
fi
COMMIT=$(git rev-parse HEAD)
echo "release check of $COMMIT"
./test.sh >/dev/null 2>&1 || { echo "./test.sh failed on this commit: run it to see why"; exit 1; }
echo "tests: pass"

build() { # network features out
  rm -rf "$3"
  cargo build-sbf --tools-version v1.53 --features "$2" --sbf-out-dir "$3" >/dev/null 2>&1
  (cd router && cargo build-sbf --tools-version v1.53 --features "$2" --sbf-out-dir "../$3" >/dev/null 2>&1)
}
for net in devnet x1; do
  case $net in devnet) F=devnet ;; x1) F=devnet,x1 ;; esac
  # A fresh build twice: the build cache is cleared for our two crates in between.
  build $net $F target/release-a-$net
  cargo clean -p percolator-vault >/dev/null 2>&1 || true
  (cd router && cargo clean -p percolator-router >/dev/null 2>&1 || true)
  build $net $F target/release-b-$net
  for p in percolator_vault percolator_router; do
    a=$(sha256sum target/release-a-$net/$p.so | cut -d' ' -f1)
    b=$(sha256sum target/release-b-$net/$p.so | cut -d' ' -f1)
    [ "$a" = "$b" ] || { echo "$p ($net) does not build the same twice: $a vs $b"; exit 1; }
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $COMMIT $net $p $a" >> deploy/releases.log
    echo "$net $p: $a"
  done
done
echo "release check passed: hashes recorded in deploy/releases.log"
