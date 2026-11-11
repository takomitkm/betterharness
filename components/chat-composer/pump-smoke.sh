. /d/yzd/zcode-e2e/env.sh
export PATH=/usr/bin:/bin:"$PATH"
set -u
cd /d/yzd/composer-rust-3
rm -rf crates plugins app-react && tar xzf src.tgz && rm -f src.tgz
cd crates/composer-bridge-wasm
rm -rf pkg
cargo build --release --target wasm32-unknown-unknown -p composer-bridge-wasm 2>&1 | tail -1
wasm-bindgen --target web --out-dir pkg ../../target/wasm32-unknown-unknown/release/composer_bridge_wasm.wasm
node verify/engine-pump-smoke.mjs 2>&1 | tail -12
