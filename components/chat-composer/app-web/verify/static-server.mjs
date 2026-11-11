// 静态服务（Web WASM MIME 必须正确）+ index.html 模板。
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

export function startStaticServer(root, port = 0) {
  const files = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/app_web.js", ["app_web.js", "text/javascript; charset=utf-8"]],
    ["/app_web.js.map", ["app_web.js.map", "application/json"]],
    ["/app_web_bg.wasm", ["app_web_bg.wasm", "application/wasm"]],
    ["/island.js", ["island.js", "text/javascript; charset=utf-8"]],
  ]);
  const server = createServer(async (request, response) => {
    const entry = files.get(new URL(request.url, "http://x").pathname);
    if (!entry) { response.writeHead(404); response.end("nf"); return; }
    try {
      response.writeHead(200, { "Content-Type": entry[1] });
      response.end(await readFile(join(root, entry[0])));
    } catch { response.writeHead(404); response.end("nf"); }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}/`,
      close: () => server.close(),
    }));
  });
}

export const INDEX_HTML = String.raw`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>bh composer · island PoC</title>
  <style>
    body { font: 16px/1.6 system-ui, sans-serif; margin: 24px; }
    .panel { max-width: 720px; margin: 0 auto; }
    .editor { min-height: 110px; border: 1px solid #999; border-radius: 8px; padding: 8px; }
    .outbox { list-style: none; padding: 0; }
    .record { border-top: 1px dashed #bbb; padding: 6px 0; }
    .lexical-island-placeholder { color: #999; }
  </style>
</head>
<body>
  <div id="main"></div>
  <script src="island.js"></script>
  <script type="module">
    import init from './app_web.js';
    init().catch((error) => { document.body.prepend('WASM init failed: ' + error); });
  </script>
</body>
</html>
`;
