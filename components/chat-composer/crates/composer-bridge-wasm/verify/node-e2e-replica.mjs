// 浏览器事件序列的 Node 确定性复刻：end-turn + hold + B 草稿全流程。
// 定位浏览器 E2E 中 re-deliver/uncertain 的根因。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const href = input instanceof URL ? input.href : String(input);
  if (href.startsWith('file:')) {
    const bytes = await readFile(fileURLToPath(input));
    return new Response(bytes, { headers: { 'Content-Type': href.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' } });
  }
  return realFetch(input, init);
};

const { default: init, WasmBridge } = await import('../pkg/composer_bridge_wasm.js');
await init({ module_or_path: new URL('../pkg/composer_bridge_wasm_bg.wasm', import.meta.url) });

// hold 回环：首请求挂起直到 release
let holdGate = null;
const accepted = [];
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    if (request.method === 'POST' && request.url === '/api/send') {
      const payload = JSON.parse(body);
      const settle = () => {
        if (!accepted.some((entry) => entry.id === payload.id)) accepted.push(payload);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'accepted', receipt: { id: payload.id, scopeId: payload.scopeId, turnId: 'turn-' + payload.id } }));
      };
      if (payload.snapshot.text === 'A' && holdGate) { holdGate.push(settle); holdGate = null; return; }
      settle();
      return;
    }
    if (request.url === '/api/stats') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ executions: accepted.length, messages: accepted, held: holdGate ? 1 : 0 }));
      return;
    }
    if (request.url === '/api/release') {
      const gates = holdGate; holdGate = [];
      for (const settle of gates ?? []) settle();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"released":true}');
      return;
    }
    response.writeHead(404); response.end('{}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const serverUrl = `http://127.0.0.1:${server.address().port}/`;

const scope = 'node-e2e';
const bridge = new WasmBridge(scope, null);
let view = JSON.parse(bridge.snapshot());
let holdMode = false;
let heldSettlers = [];
const transport = {
  async send(request) {
    if (holdMode) {
      await new Promise((resolve) => heldSettlers.push(() => resolve({ status: 'accepted', receipt: { id: request.id, scopeId: scope, turnId: 'turn-' + request.id } })));
      return { status: 'accepted', receipt: { id: request.id, scopeId: scope, turnId: 'turn-' + request.id } };
    }
    const response = await realFetch(new URL('api/send', serverUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.id },
      body: JSON.stringify({ id: request.id, scopeId: request.scopeId, snapshot: { ...request.snapshot, attachments: [] }, delivery: request.delivery, turnId: request.turnId }),
    });
    return response.json();
  },
  async lookup() { return { status: 'uncertain', reason: 'n/a' }; },
};

async function pump(result, tag) {
  let current = result;
  for (let guard = 0; current !== null && guard < 64; guard += 1) {
    let next = null;
    for (const ref of current.effects) {
      if (ref.ref_id === 0) continue;
      const effect = ref.effect;
      let outcome = null;
      if (effect.type === 'persist') outcome = { outcome: 'persisted', ok: true };
      else if (effect.type === 'deliver') {
        const sendResult = await transport.send({
          id: effect.id, scopeId: scope,
          snapshot: view.state.submissions.find((submission) => submission.id === effect.id)?.snapshot ?? { text: '', attachments: [], references: [] },
          delivery: effect.delivery, turnId: effect.turn,
        }, {});
        const receipt = sendResult.status === 'accepted'
          ? { id: sendResult.receipt.id, scope, turn: sendResult.receipt.turnId } : undefined;
        outcome = sendResult.status === 'accepted'
          ? { outcome: 'delivered', result: { status: 'accepted', receipt } }
          : sendResult.status === 'rejected'
            ? { outcome: 'delivered', result: { status: 'rejected', reason: sendResult.reason } }
            : { outcome: 'delivered', result: { status: 'uncertain', reason: sendResult.reason } };
      } else if (effect.type === 'schedule_timeout') {
        console.log(`[${tag}] schedule_timeout reached (未先 accepted)`);
        return 'timeout-first';
      } else {
        return 'cancel';
      }
      if (outcome) {
        next = JSON.parse(bridge.ack(ref.ref_id, JSON.stringify(outcome)));
        view = next.snapshot;
      }
    }
    current = next;
  }
  return 'done';
}

const statusOf = (text) => view.state.submissions.find((submission) => submission.snapshot.text === text)?.status;

// —— 浏览器事件序列精确复刻 ——
let step = await pump(JSON.parse(bridge.dispatch(JSON.stringify({ type: 'edit', text: '你好 Bridge' }))), 'e1');
step = await pump(JSON.parse(bridge.dispatch(JSON.stringify({ type: 'submit' }))), 's1');
console.log('[s1] msg1:', statusOf('你好 Bridge'));
step = await pump(JSON.parse(bridge.dispatch(JSON.stringify({ type: 'end_turn', turn_id: view.state.active_turn }))), 'end1');
console.log('[end1] active_turn:', view.state.active_turn);
holdMode = true;
await pump(JSON.parse(bridge.dispatch(JSON.stringify({ type: 'edit', text: 'A' }))), 'e2');
// s2 的泵会等 release（浏览器同构：ChatComposer 不 await submit）——先触发再放行。
const s2pump = pump(JSON.parse(bridge.dispatch(JSON.stringify({ type: 'submit' }))), 's2');
await new Promise((resolve) => setTimeout(resolve, 30));
console.log('[s2] A:', statusOf('A'), 'heldSettlers:', heldSettlers.length);
holdMode = false;
for (const settle of heldSettlers) settle();
heldSettlers = [];
await s2pump;
console.log('[release] A:', statusOf('A'), 'draft B:', view.state.draft.snapshot.text);
step = await pump(JSON.parse(bridge.dispatch(JSON.stringify({ type: 'edit', text: 'B' }))), 'e3');
console.log('[e3] B draft:', view.state.draft.snapshot.text, 'A:', statusOf('A'));

const pass = statusOf('你好 Bridge') === 'accepted' && statusOf('A') === 'accepted' && view.state.draft.snapshot.text === 'B';
console.log(pass ? 'PASS: Node 全序列复刻通过' : 'FAIL');
server.close();
process.exit(pass ? 0 : 1);
