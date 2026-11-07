// Cross-boundary smoke test for the compiled wasm bindings.
// Prerequisite (school server): cargo build --release --target wasm32-unknown-unknown
//   && wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/composer_core.wasm
// Then place pkg/ next to this file and run: node verify/wasm-smoke.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The wasm-bindgen "web" target expects a browser fetch; wire it to local files.
globalThis.fetch = async (input) => {
  const path = input instanceof URL ? fileURLToPath(input) : String(input);
  const bytes = await readFile(path);
  return new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } });
};

const { default: init, ComposerCore } = await import('../pkg/composer_core.js');
await init({ module_or_path: new URL('../pkg/composer_core_bg.wasm', import.meta.url) });

const results = [];
const check = (name, cond, detail) => results.push({ name, pass: Boolean(cond), detail });

// 1. Construct and edit.
let core = new ComposerCore('scope-1', 'gen-0');
core.edit('A', '[]', '[]');
check('构造后草稿可写', core.draftText === 'A', core.draftText);
check('generation 暴露给宿主', core.draftGeneration === 'gen-0', core.draftGeneration);

// 2. Handoff moves payload and opens a new generation.
const messageId = core.handoff('m1', 'gen-1', false, 1000);
check('handoff 返回消息 ID', messageId === 'm1', messageId);
check('交接后草稿清空', core.draftText === '', core.draftText);
check('交接后换新 generation', core.draftGeneration === 'gen-1', core.draftGeneration);
check('账本含一条消息', JSON.parse(core.submissionsJson()).length === 1);

// 3. Empty draft cannot be handed off.
let threw = null;
try { core.handoff('m2', 'gen-2', false, 1001); } catch (error) { threw = String(error); }
check('空草稿拒绝交接', threw !== null && threw.includes('wrong_status'), threw);

// 4. Late acceptance must not touch the new draft.
const started = JSON.parse(core.beginNext('a1'));
core.edit('B', '[]', '[]');
const settled = core.settle('m1', started.attempt, JSON.stringify({
  status: 'accepted',
  receipt: { id: 'm1', scope: 'scope-1', turn: 'turn-1' },
}));
check('接纳结果落账', settled === 'accepted', settled);
check('迟到接纳不清新草稿', core.draftText === 'B', core.draftText);
check('轮次未结束前 start 不推进', core.beginNext('a2') === null);
core.endTurn('turn-1');

// 5. Wrong-scope receipt becomes uncertain, not accepted.
core.edit('C', '[]', '[]');
core.handoff('m3', 'gen-2b', false, 1002);
const started2 = JSON.parse(core.beginNext('a2'));
const bad = core.settle('m3', started2.attempt, JSON.stringify({
  status: 'accepted',
  receipt: { id: 'm3', scope: 'other-scope', turn: 'turn-2' },
}));
check('跨 scope 回执降级为 uncertain', bad === 'uncertain', bad);
const uncertain = JSON.parse(core.submissionsJson()).find((item) => item.id === 'm3');
check('uncertain 记录保留原因', Boolean(uncertain?.reason), JSON.stringify(uncertain));

// 6. Uncertain blocks dispatch and forbids retry/restore/remove.
check('uncertain 阻塞派发', core.hasBlocking() === true);
for (const [name, fn] of [
  ['retry', () => core.retry('m3')],
  ['restore', () => core.restore('m3', 'gen-x')],
  ['remove', () => core.remove('m3')],
]) {
  let error = null;
  try { fn(); } catch (caught) { error = String(caught); }
  check(`uncertain 拒绝 ${name}`, error !== null && error.includes('wrong_status'), error);
}

// 7. Serialisation round-trip preserves the ledger and draft.
const json = core.to_json();
const restored = ComposerCore.fromJson(json);
check('序列化往返保留草稿', restored.draftText === core.draftText, restored.draftText);
check('序列化往返保留 uncertain', JSON.parse(restored.submissionsJson()).some((item) => item.status === 'uncertain'));
check('revision 可读', typeof restored.revision === 'number' && restored.revision >= 0, String(restored.revision));

// 8. Corrupt or foreign schema is refused instead of overwritten.
let corrupt = null;
try { ComposerCore.fromJson('{"schema":99}'); } catch (error) { corrupt = String(error); }
check('未知 schema 拒绝加载', corrupt !== null, corrupt);

// 9. A rejected message keeps its identity on retry (fresh scope).
core = new ComposerCore('scope-2', 'g2-0');
core.edit('D', '[]', '[]');
const rejectedId = core.handoff('m4', 'gen-3', false, 1003);
const attempt4 = JSON.parse(core.beginNext('a3'));
const rejected = core.settle(rejectedId, attempt4.attempt, JSON.stringify({ status: 'rejected', reason: 'not admitted' }));
check('明确拒绝落账', rejected === 'rejected', rejected);
core.retry('m4');
check('重试保持原消息 ID', JSON.parse(core.submissionsJson()).find((item) => item.id === rejectedId).status === 'queued');
check('重试不计入重复消息', JSON.parse(core.submissionsJson()).filter((item) => item.id === 'm4').length === 1);

const failed = results.filter((item) => !item.pass);
for (const item of results) {
  console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `  [${item.detail}]` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
