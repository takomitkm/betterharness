// 极简静态服务：/、app_web.js、app_web_bg.wasm（MIME 必须 application/wasm）、island.js。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2] ?? '.';
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app_web.js', ['app_web.js', 'text/javascript; charset=utf-8']],
  ['/app_web_bg.wasm', ['app_web_bg.wasm', 'application/wasm']],
  ['/island.js', ['island.js', 'text/javascript; charset=utf-8']],
]);
createServer(async (request, response) => {
  const entry = files.get(new URL(request.url, 'http://x').pathname);
  if (!entry) { response.writeHead(404); response.end('nf'); return; }
  try {
    response.writeHead(200, { 'Content-Type': entry[1] });
    response.end(await readFile(join(root, entry[0])));
  } catch { response.writeHead(404); response.end('nf'); }
}).listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/`));
