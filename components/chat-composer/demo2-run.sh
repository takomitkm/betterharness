. /d/yzd/zcode-e2e/env.sh
export PATH=/usr/bin:/bin:"$PATH"
set -u
mkdir -p /d/yzd/ts-stage && cd /d/yzd/ts-stage && rm -rf app-react && tar xzf /d/yzd/composer-app-react/src.tgz
cd app-react
export CE_BROWSER_CHANNEL=msedge
npm ci --registry=https://registry.npmmirror.com --no-audit --no-fund 2>&1 | tail -1
npm run typecheck 2>&1 | tail -2
taskkill //F //IM msedge.exe >/dev/null 2>&1 || true
node verify/demo2-wasm.mjs 2>&1
