. /d/yzd/zcode-e2e/env.sh
export PATH=/usr/bin:/bin:"$PATH"
set -u
cd /d/yzd/composer-rust-3
rm -rf crates plugins && tar xzf /d/yzd/composer-rust-3/src.tgz
cargo test --workspace --no-fail-fast 2>&1 | grep "test result" | awk '{s+=$4; f+=$6} END {print "TOTAL passed:", s, "failed:", f}'
cargo check --target wasm32-unknown-unknown -p composer-bridge-wasm 2>&1 | tail -1
cargo fmt && echo FMT-DONE
tar czf /d/yzd/composer-fmt4.tgz crates plugins Cargo.toml Cargo.lock
echo TARBALL-DONE
