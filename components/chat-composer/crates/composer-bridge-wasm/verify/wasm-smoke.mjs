// WasmBridge 冒烟测试：真实 Rust WASM Core 在 JS 里跑通首要链路。
// 前置（校机）：
//   cargo build --release --target wasm32-unknown-unknown -p composer-bridge-wasm
//   wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/composer_bridge_wasm.wasm
// 运行：node verify/wasm-smoke.mjs（在 composer-bridge-wasm 目录）
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// wasm-bindgen "web" target 用浏览器 fetch 取 .wasm；Node 里接到本地文件。
globalThis.fetch = async (input) => {
  const path = input instanceof URL ? fileURLToPath(input) : String(input);
  const bytes = await readFile(path);
  return new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } });
};

const { default: init, WasmBridge } = await import('../pkg/composer_bridge_wasm.js');
await init({ module_or_path: new URL('../pkg/composer_bridge_wasm_bg.wasm', import.meta.url) });

const results = [];
const check = (name, cond, detail) => results.push({ name, pass: Boolean(cond), detail });

// 1. 全新会话：快照 revision 0，protocol_version 1。
let bridge = new WasmBridge("demo/main", null);
let snap = JSON.parse(bridge.snapshot());
check('快照带协议版本', snap.protocol_version === 1, snap.protocol_version);
check('revision 从 0 起', snap.revision === 0, snap.revision);
check('空草稿', snap.state.draft.snapshot.text === '', snap.state.draft.snapshot.text);

// 2. Edit → Persist 引用 → ack：草稿落库。
let result = JSON.parse(bridge.dispatch(JSON.stringify({ type: 'edit', text: '你好' })));
const persistRef = result.effects.find((effect) => effect.effect.type === 'persist');
check('Edit 产出 Persist 引用', Boolean(persistRef), JSON.stringify(result.effects.map((e) => e.effect.type)));
check('Edit 不开交接窗口（admitting 仅 Submit，TS 对齐）', result.snapshot.admitting === false, result.snapshot.admitting);
result = JSON.parse(bridge.ack(persistRef.ref_id, JSON.stringify({ outcome: 'persisted', ok: true })));
check('ack 后 admitting 关闭', result.snapshot.admitting === false, result.snapshot.admitting);
check('草稿 = 你好', result.snapshot.state.draft.snapshot.text === '你好', result.snapshot.state.draft.snapshot.text);
check('revision 单调递增', result.snapshot.revision >= 2, result.snapshot.revision);

// 3. Submit → Persist → ack → Deliver + ScheduleTimeout（真实 Rust Runtime 泵送）。
result = JSON.parse(bridge.dispatch(JSON.stringify({ type: 'submit' })));
check('Submit 交接后草稿清空（FM01）', result.snapshot.state.draft.snapshot.text === '', result.snapshot.state.draft.snapshot.text);
check('outbox 一条 queued', result.snapshot.state.submissions.length === 1 && result.snapshot.state.submissions[0].status === 'queued', JSON.stringify(result.snapshot.state.submissions.map((s) => s.status)));
const submitPersist = result.effects.find((effect) => effect.effect.type === 'persist');
result = JSON.parse(bridge.ack(submitPersist.ref_id, JSON.stringify({ outcome: 'persisted', ok: true })));
const deliverRef = result.effects.find((effect) => effect.effect.type === 'deliver');
const timeoutRef = result.effects.find((effect) => effect.effect.type === 'schedule_timeout');
check('pump 派发 Deliver（真实引擎）', Boolean(deliverRef), JSON.stringify(result.effects.map((e) => e.effect.type)));
check('超时排程在册', Boolean(timeoutRef), JSON.stringify(result.effects.map((e) => e.effect.type)));
const messageId = deliverRef.effect.id;

// 4. Deliver 回执 accepted → Persist → ack：outbox Accepted（Outbox 可见，首要链路完成）。
result = JSON.parse(
  bridge.ack(deliverRef.ref_id, JSON.stringify({
    outcome: 'delivered',
    result: { status: 'accepted', receipt: { id: messageId, scope: 'demo/main', turn: 'turn-' + messageId } },
  })),
);
const settlePersist = result.effects.find((effect) => effect.effect.type === 'persist');
result = JSON.parse(bridge.ack(settlePersist.ref_id, JSON.stringify({ outcome: 'persisted', ok: true })));
check('outbox Accepted（首要链路：输入→Bridge→Rust Runtime→Outbox）', result.snapshot.state.submissions[0].status === 'accepted', JSON.stringify(result.snapshot.state.submissions.map((s) => s.status)));
check('回执轮次激活', result.snapshot.state.active_turn === 'turn-' + messageId, result.snapshot.state.active_turn);
check('pending 清零', result.snapshot.pending_receipt_count === 0, result.snapshot.pending_receipt_count);

// 5. ack 幂等：重复引用必须 Err（不重复提交事务）。
let duplicateErrored = false;
try {
  bridge.ack(deliverRef.ref_id, JSON.stringify({ outcome: 'delivered', result: { status: 'accepted', receipt: { id: messageId, scope: 'demo/main', turn: 'turn-x' } } }));
} catch (error) {
  duplicateErrored = String(error).includes('UnknownRef');
}
check('重复回执 Err UnknownRef（幂等守卫）', duplicateErrored, 'no error thrown');

// 6. 持久化恢复：sending 状态的 JSON 进构造器 → unknown（FM09）。
const persisted = JSON.parse(bridge.snapshot());
const sendingState = structuredClone(persisted.state);
sendingState.submissions[0].status = 'sending';
const restored = new WasmBridge("demo/main", JSON.stringify(sendingState));
const restoredSnap = JSON.parse(restored.snapshot());
check('恢复把 sending 转 unknown（FM09）', restoredSnap.state.submissions[0].status === 'uncertain', restoredSnap.state.submissions[0].status);

// 7. 坏 JSON 显式报错。
let invalidErrored = false;
try {
  bridge.dispatch('{ not json');
} catch (error) {
  invalidErrored = String(error).includes('invalid event');
}
check('坏事件 JSON 显式报错', invalidErrored, 'no error thrown');

const failed = results.filter((item) => !item.pass);
for (const item of results) {
  console.log(`${item.pass ? '✔' : '✖'} ${item.name}${item.pass ? '' : ` — ${item.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
