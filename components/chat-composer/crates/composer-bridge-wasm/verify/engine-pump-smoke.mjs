// WasmEngine 泵语义的 Node 复刻：同 wasm BridgeCore + 同泵链（persist→deliver→persist）
// + Node fetch 到 demo-server 回环。分离「JS 泵逻辑 bug」与「浏览器环境问题」。
// 运行（校机，先 npm i app-react 装好 playwright 不需要——只 node）：
//   node crates/composer-bridge-wasm/verify/engine-pump-smoke.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

// 极简回环：/api/send 立即 accepted（幂等不重复派发）——与 demo fixture 同语义的子集。
const accepted = [];
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    if (request.method === 'POST' && request.url === '/api/send') {
      const payload = JSON.parse(body);
      if (!accepted.some((entry) => entry.id === payload.id)) accepted.push(payload);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'accepted', receipt: { id: payload.id, scopeId: payload.scopeId, turnId: 'turn-' + payload.id } }));
      return;
    }
    if (request.url === '/api/stats') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ executions: accepted.length, messages: accepted, held: 0 }));
      return;
    }
    response.writeHead(404); response.end('{}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const serverUrl = `http://127.0.0.1:${server.address().port}/`;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const href = input instanceof URL ? input.href : String(input);
  if (href.startsWith('file:')) {
    const bytes = await readFile(fileURLToPath(input));
    return new Response(bytes, { headers: { 'Content-Type': href.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' } });
  }
  return realFetch(input, init); // http(s) 真实回环请求走 Node fetch。
};

const { default: init, WasmBridge } = await import('../pkg/composer_bridge_wasm.js');
await init({ module_or_path: new URL('../pkg/composer_bridge_wasm_bg.wasm', import.meta.url) });


const scope = 'pump-smoke';
const transport = {
  async send(request) {
    const response = await fetch(new URL('api/send', serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.id, 'X-Demo-Scenario': 'normal' },
      body: JSON.stringify({ ...request, snapshot: { ...request.snapshot, attachments: [] } }),
    });
    if (!response.ok) return { status: 'uncertain', reason: `HTTP ${response.status}` };
    return response.json();
  },
  async lookup() { return { status: 'uncertain', reason: 'n/a' }; },
};

const bridge = new WasmBridge(scope, null);
let view = JSON.parse(bridge.snapshot());
const log = (tag, result) => console.log(`[${tag}] rev=${result.snapshot.revision} effects=${JSON.stringify(result.effects.map((ref) => `${ref.ref_id}:${ref.effect.type}`))} status=${JSON.stringify(result.snapshot.state.submissions.map((submission) => submission.status))}`);

// 泵（与 WasmEngine 相同语义）
async function pump(result) {
  let current = result;
  for (let guard = 0; current !== null && guard < 64; guard += 1) {
    let next = null;
    for (const ref of current.effects) {
      if (ref.ref_id === 0) continue;
      const effect = ref.effect;
      let outcome = null;
      if (effect.type === 'persist') outcome = { outcome: 'persisted', ok: true };
      else if (effect.type === 'deliver') {
        console.log('[pump] deliver start', effect.id);
        const sendResult = await transport.send({
          id: effect.id, scopeId: scope,
          snapshot: view.state.submissions.find((submission) => submission.id === effect.id)?.snapshot ?? { text: '', attachments: [], references: [] },
          delivery: effect.delivery, turnId: effect.turn,
        }, { signal: new AbortController().signal });
        console.log('[pump] transport resolved', JSON.stringify(sendResult));
        const receipt = sendResult.status === 'accepted' ? { id: sendResult.receipt.id, scope: scope, turn: sendResult.receipt.turnId } : undefined;
        outcome = sendResult.status === 'accepted'
          ? { outcome: 'delivered', result: { status: 'accepted', receipt } }
          : sendResult.status === 'rejected'
            ? { outcome: 'delivered', result: { status: 'rejected', reason: sendResult.reason } }
            : { outcome: 'delivered', result: { status: 'uncertain', reason: sendResult.reason } };
      } else if (effect.type === 'schedule_timeout') return console.log('[pump] schedule reached — stopping (accepted expected before)');
      if (outcome) {
        next = JSON.parse(bridge.ack(ref.ref_id, JSON.stringify(outcome)));
        view = next.snapshot;
        log('ack', next);
      }
    }
    current = next;
  }
}

let result = JSON.parse(bridge.dispatch(JSON.stringify({ type: 'edit', text: '你好 Node 泵' })));
await pump(result);
result = JSON.parse(bridge.dispatch(JSON.stringify({ type: 'submit' })));
await pump(result);
view = JSON.parse(bridge.snapshot()).state;
const status = view.submissions[0]?.status;
console.log(status === 'accepted' ? 'PASS: Node 泵复刻全链 Accepted' : `FAIL: status=${status}`);
server.close();
process.exit(status === 'accepted' ? 0 : 1);
