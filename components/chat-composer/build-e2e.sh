. /d/yzd/zcode-e2e/env.sh
export PATH=/usr/bin:/bin:"$PATH"
set -u
BASE=/d/yzd/composer-rust-3
cd "$BASE"

echo "== 1. workspace tests:"
cargo test --workspace --no-fail-fast 2>&1 | grep "test result" | awk '{s+=$4; f+=$6} END {print "RUST passed:", s, "failed:", f}'

echo "== 2. app-web wasm32 build + bindgen:"
cd "$BASE/app-web"
cargo build --release --target wasm32-unknown-unknown 2>&1 | tail -1
mkdir -p vendor
wasm-bindgen --target web --out-dir vendor --out-name app_web target/wasm32-unknown-unknown/release/app-web.wasm 2>&1 | tail -1
ls vendor/app_web.js && echo "app_web.js OK" || echo "app_web.js MISSING"

echo "== 3. lexical-island bundle:"
cd "$BASE/lexical-island"
npm install --registry=https://registry.npmmirror.com --no-audit --no-fund 2>&1 | tail -1
npm run build 2>&1 | tail -1
cp .runtime/island.js "$BASE/app-web/vendor/island.js"

echo "== 4. bridge wasm + bindgen:"
cd "$BASE/crates/composer-bridge-wasm"
rm -rf pkg
cargo build --release --target wasm32-unknown-unknown -p composer-bridge-wasm 2>&1 | tail -1
wasm-bindgen --target web --out-dir pkg --out-name composer_bridge_wasm "$BASE/target/wasm32-unknown-unknown/release/composer_bridge_wasm.wasm" 2>&1 | tail -1
cp pkg/composer_bridge_wasm.js pkg/composer_bridge_wasm_bg.wasm "$BASE/app-web/vendor/"

echo "== 5. island E2E:"
cd "$BASE/app-web"
taskkill //F //IM msedge.exe >/dev/null 2>&1 || true
export CE_BROWSER_CHANNEL=msedge
node verify/island-e2e.mjs 2>&1 | tail -16
