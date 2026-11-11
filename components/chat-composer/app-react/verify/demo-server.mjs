import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildDemo } from './build-demo.mjs';

/** Loopback-only executable fixture. Persists receipts before replying, and deduplicates by scope + ID. */
export async function startDemoServer({ port = 0, journalDirectory } = {}) {
  const publicDirectory = await buildDemo();
  const temporary = !journalDirectory;
  const directory = journalDirectory ?? await mkdtemp(join(tmpdir(), 'betterharness-receipts-'));
  const journal = join(directory, 'receipts.json');
  let records = new Map();
  try { records = new Map(JSON.parse(await readFile(journal, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const held = new Set();
  let serial = Promise.resolve();

  function json(response, value, status = 200) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }
  async function persist(next) {
    const file = await open(journal + '.tmp', 'w');
    try { await file.writeFile(JSON.stringify([...next])); await file.sync(); }
    finally { await file.close(); }
    await rename(journal + '.tmp', journal);
    records = next;
  }
  async function bodyOf(request) {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) throw new Error('Demo upload exceeds 32 MiB');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname === '/api/send') {
        const payload = await bodyOf(request);
        if (!payload.id || !payload.scopeId || !payload.snapshot || request.headers['idempotency-key'] !== payload.id) {
          return json(response, { status: 'rejected', reason: 'Invalid submission envelope; not admitted' });
        }
        const key = JSON.stringify([payload.scopeId, payload.id]);
        const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        const scenario = request.headers['x-demo-scenario'];
        const operation = serial.then(async () => {
          const existing = records.get(key);
          if (existing?.result.status === 'accepted') {
            if (existing.hash !== hash) return { status: 'unknown', reason: 'An admitted ID was reused with a different payload' };
            return existing.result;
          }
          const result = scenario === 'reject'
            ? { status: 'rejected', reason: 'Demo host explicitly refused admission' }
            : { status: 'accepted', receipt: { id: payload.id, scopeId: payload.scopeId, turnId: payload.delivery === 'steer' ? payload.turnId : 'turn-' + payload.id } };
          const next = new Map(records);
          next.set(key, { hash, payload, result });
          await persist(next);
          return result;
        });
        serial = operation.catch(() => undefined);
        const result = await operation;
        if (scenario === 'lost-ack') { response.destroy(); return; }
        if (scenario === 'hold') {
          const release = () => { held.delete(release); if (!response.destroyed) json(response, result); };
          held.add(release);
          response.on('close', () => held.delete(release));
          return;
        }
        return json(response, result);
      }
      if (request.method === 'GET' && url.pathname === '/api/receipt') {
        const key = JSON.stringify([url.searchParams.get('scopeId'), url.searchParams.get('id')]);
        return json(response, records.get(key)?.result ?? { status: 'unknown', reason: 'No authoritative receipt available; not resent' });
      }
      if (request.method === 'GET' && url.pathname === '/api/stats') {
        const accepted = [...records.values()].filter((record) => record.result.status === 'accepted');
        return json(response, {
          executions: accepted.length, held: held.size,
          messages: accepted.map(({ payload, hash }) => ({ ...payload, hash })),
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/release') {
        for (const release of [...held]) release();
        return json(response, { released: true });
      }
      const files = new Map([
        ['/', ['index.html', 'text/html; charset=utf-8']],
        ['/demo.js', ['demo.js', 'text/javascript; charset=utf-8']],
        ['/demo.js.map', ['demo.js.map', 'application/json']],
        // 真实 Rust Core WASM（wasm=1 时由 WasmEngine 动态加载；MIME 必须正确，否则编译实例化被拒）。
        ['/wasm/composer_bridge_wasm.js', ['vendor/composer_bridge_wasm.js', 'text/javascript; charset=utf-8']],
        ['/wasm/composer_bridge_wasm_bg.wasm', ['vendor/composer_bridge_wasm_bg.wasm', 'application/wasm']],
      ]);
      const file = files.get(url.pathname);
      if (request.method !== 'GET' || !file) { console.log('[server] 404:', request.method, url.pathname); return json(response, { error: 'Not found' }, 404); }
      response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
      response.end(await readFile(join(publicDirectory, file[0])));
    } catch (error) {
      if (!response.destroyed) json(response, { status: 'unknown', reason: String(error) }, 500);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url,
    async close() {
      for (const release of [...held]) release();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await serial;
      if (temporary) await rm(directory, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const running = await startDemoServer({ port: Number(process.env.PORT ?? 5179) });
  console.log(running.url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await running.close(); process.exit(0); });
}
