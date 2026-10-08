#!/bin/sh
# Builds the on-chain programs (vault and router), then runs every test against them and the
# Percolator binary.
set -e
cd "$(dirname "$0")"
cargo build-sbf --tools-version v1.53 --sbf-out-dir target/deploy >/dev/null 2>&1 || cargo build-sbf --tools-version v1.53 --sbf-out-dir target/deploy
(cd router && cargo build-sbf --tools-version v1.53 --sbf-out-dir ../target/deploy >/dev/null 2>&1 || cargo build-sbf --tools-version v1.53 --sbf-out-dir ../target/deploy)
cp keys/percolator_vault-keypair.json target/deploy/percolator_vault-keypair.json
cp keys/router-keypair.json target/deploy/percolator_router-keypair.json
cargo test "$@"

# The X1 build (reported prices instead of Pyth): its own binaries, its own tests.
cargo build-sbf --tools-version v1.53 --features x1 --sbf-out-dir target/deploy-x1-test >/dev/null 2>&1 || cargo build-sbf --tools-version v1.53 --features x1 --sbf-out-dir target/deploy-x1-test
(cd router && cargo build-sbf --tools-version v1.53 --features x1 --sbf-out-dir ../target/deploy-x1-test >/dev/null 2>&1 || cargo build-sbf --tools-version v1.53 --features x1 --sbf-out-dir ../target/deploy-x1-test)
cargo test --features x1 --test x1 "$@"
