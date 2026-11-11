// 静态服务：递归服务指定目录下所有文件（正确的 MIME 映射）。
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, extname } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ts": "text/javascript; charset=utf-8",
  ".d.ts": "application/json",
};

export function startStaticServer(root, port = 0) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://x").pathname;
      const filePath = join(root, pathname === "/" ? "index.html" : pathname);
      const data = await readFile(filePath);
      const ext = extname(filePath);
      const mime = MIME[ext] ?? "application/octet-stream";
      response.writeHead(200, { "Content-Type": mime });
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
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
    import init, { composer_view_json } from './app_web.js';
    init().then(() => {
      // PoC 测试钩子：E2E 断言走 __composerView().state.<台账字段>。
      window.__composerView = () => ({ state: JSON.parse(composer_view_json()) });
    }).catch((error) => { document.body.prepend('WASM init failed: ' + error); });
  </script>
</body>
</html>
`;
