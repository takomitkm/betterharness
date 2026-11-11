. /d/yzd/zcode-e2e/env.sh
export PATH=/usr/bin:/bin:"$PATH"
set -u
cd /d/yzd/composer-rust-3
# Rust 单元回归（每次构建前确认）
cargo test --workspace --no-fail-fast 2>&1 | grep "test result" | awk '{s+=$4; f+=$6} END {print "RUST TOTAL passed:", s, "failed:", f}'
echo "== app-web wasm32 check:"
cargo check --target wasm32-unknown-unknown -p app-web 2>&1 | tail -1
echo "== release wasm build + bindgen:"
cargo build --release --target wasm32-unknown-unknown -p app-web 2>&1 | tail -1
cd crates/composer-bridge-wasm && rm -rf pkg && cargo build --release --target wasm32-unknown-unknown -p composer-bridge-wasm 2>&1 | tail -1 && wasm-bindgen --target web --out-dir pkg ../../target/wasm32-unknown-unknown/release/composer_bridge_wasm.wasm && cd ../..
echo "== vendor 组装:"
mkdir -p vendor
cp target/wasm32-unknown-unknown/release/app_web.wasm vendor/app_web.wasm 2>/dev/null || echo "app_web wasm missing"
cd crates/composer-bridge-wasm && rm -rf pkg && cargo build --release --target wasm32-unknown-unknown -p composer-bridge-wasm 2>&1 | tail -1 && wasm-bindgen --target web --out-dir ../../../vendor ../../target/wasm32-unknown-unknown/release/composer_bridge_wasm.wasm && cd ../..
cp ../../lexical-island/.runtime/island.js vendor/island.js 2>/dev/null || echo "island bundle missing (先 npm run build)"
ls vendor/ | head -8
