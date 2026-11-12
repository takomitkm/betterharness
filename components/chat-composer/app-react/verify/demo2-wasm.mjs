// Phase 3 端到端（真实浏览器 + 真实 Rust WASM Core）：
//   真实输入 → ChatComposer/TextareaEditor → WasmEngine → WASM Rust Runtime → 回环传输 → Outbox Accepted → UI 更新
// 运行（校机）：node verify/demo2-wasm.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startDemoServer } from './demo-server.mjs';

const server = await startDemoServer();
// CI（ubuntu runner）无 msedge：CE_BROWSER_CHANNEL=chromium → bundled chromium。
const launchChannel = () => {
  const channel = process.env.CE_BROWSER_CHANNEL;
  return channel && channel !== "chromium" ? channel : undefined;
};
const browser = await chromium.launch({ channel: launchChannel(), headless: true });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (error) => { errors.push(String(error)); console.log('[pageerror]', String(error).slice(0, 300)); });
page.on('console', (message) => { const text = message.text(); if (message.type() === 'error' || text.includes('[wasm-engine]') || text.includes('Error')) console.log('[page]', text.slice(0, 300)); });

const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: Boolean(cond), detail }); console.log(`${cond ? '✔' : '✖'} ${name}${cond ? '' : ` — ${detail}`}`); };
const snapshot = () => page.evaluate(() => {
  const view = window.composerTest.engine.getSnapshot();
  return {
    text: view.state.draft.snapshot.text,
    admitting: view.admitting, sending: view.sending, closed: view.closed,
    submissions: view.state.submissions.map((submission) => ({ id: submission.id, status: submission.status, text: submission.snapshot.text, reason: submission.reason, attemptId: submission.attemptId, attempts: submission.attempts })),
    activeTurn: view.state.activeTurn, revision: view.state.revision,
  };
});
const waitStatus = (status) => page.waitForFunction((status) =>
  window.composerTest.engine.getSnapshot().state.submissions[0]?.status === status, status)
  .catch(async (error) => {
    const probe = await page.evaluate(async () => {
    const start = Date.now();
    try {
      const response = await fetch(new URL('api/stats', location.href));
      return `stats-ok ${Date.now() - start}ms`;
    } catch (error) {
      return `stats-fail ${String(error)} ${Date.now() - start}ms`;
    }
  });
  console.log('waitStatus failed:', status, '— probe:', probe, '— snapshot:', JSON.stringify(await snapshot()) + ' pending=' + await page.evaluate(() => window.composerTest.engine.pendingCount?.() ?? 'n/a'), '— errors:', JSON.stringify(errors), '— stats:', JSON.stringify(await (await fetch(new URL('api/stats', server.url))).json()));
    throw error;
  });

// 1. 真实输入 → Enter → Accepted（首要链路全通）
const scope = `wasm-e2e-${Date.now()}`; // IndexedDB 跨 run 持久：唯一 scope 隔离每次验证。
await page.goto(`${server.url}?scope=${scope}&editor=text&wasm=1&timeout=5000`);
await page.waitForFunction(() => Boolean(window.composerTest?.engine));
check('WASM 引擎已加载', await page.evaluate(() => window.composerTest.engine.constructor.name) === 'WasmEngine', await page.evaluate(() => window.composerTest.engine.constructor.name));
await page.getByTestId('editor').fill('你好 Bridge');
await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.text === '你好 Bridge');
await page.getByTestId('editor').press('Enter');
await waitStatus('accepted');
let view = await snapshot();
check('端到端：真实输入 → Outbox Accepted', view.submissions[0]?.status === 'accepted' && view.submissions[0]?.text === '你好 Bridge', JSON.stringify(view.submissions));
check('交接后草稿清空（FM01）', view.text === '', view.text);
const stats = await (await fetch(`${server.url}api/stats`)).json();
check('宿主收到一条消息（回环 fixture）', stats.messages.length === 1 && stats.messages[0].snapshot.text === '你好 Bridge', JSON.stringify(stats.messages.map((message) => message.snapshot.text)));

// 2. hold 场景（正确前置：先结束 step 1 的轮次，A 才会走 start 派发进 sending）
await page.getByTestId('end-turn').click();
await page.getByTestId('scenario').selectOption('hold');
await page.getByTestId('editor').fill('A');
await page.getByTestId('editor').press('Enter');
await page.waitForFunction(async () => (await (await fetch(new URL('api/stats', location.href))).json()).held > 0);
view = await snapshot();
const holdA = view.submissions.find((submission) => submission.text === 'A');
check('hold：A 在途 sending', holdA?.status === 'sending' && view.sending === true, JSON.stringify(view.submissions.map((submission) => `${submission.text}:${submission.status}`)));
await page.getByTestId('editor').fill('B');
await page.getByTestId('release').click();
await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.submissions.find((submission) => submission.snapshot.text === 'A')?.status === 'accepted');
view = await snapshot();
check('release 后 A Accepted', view.submissions.find((submission) => submission.text === 'A')?.status === 'accepted', JSON.stringify(view.submissions.map((submission) => `${submission.text}:${submission.status}`)));
check('迟到接纳不擦 B 草稿（FM02）', view.text === 'B', view.text);

// 3. 队列：A 接纳后轮次激活，C 排队（FM11）；end-turn 后派发并接纳（FM12）——按文本定位。
await page.getByTestId('scenario').selectOption('normal');
await page.getByTestId('editor').fill('C');
await page.getByTestId('editor').press('Enter');
await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.submissions.find((submission) => submission.snapshot.text === 'C')?.status === 'queued')
  .catch(async (error) => {
    console.log('C-queue wait failed:', JSON.stringify(await snapshot()));
    throw error;
  });
view = await snapshot();
check('忙时 C 排队（FM11 持久快照）', view.submissions.find((submission) => submission.text === 'C')?.status === 'queued' && view.text === '', JSON.stringify(view.submissions.map((submission) => `${submission.text}:${submission.status}`)) + ' turn=' + view.activeTurn);
await page.getByTestId('end-turn').click();
await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.submissions.find((submission) => submission.snapshot.text === 'C')?.status === 'accepted');
check('end-turn 后 C 派发并 Accepted（FM12）', (await snapshot()).submissions.find((submission) => submission.text === 'C')?.status === 'accepted');

// 4. 取消全部场景收尾：无页面错误
// 7. 无未捕获错误
// IDB 持久化：reload 后 Outbox Accepted 恢复
await page.reload();
await page.waitForFunction(() => Boolean(window.composerTest?.engine), { timeout: 15000 });
await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.submissions.length > 0, { timeout: 10000 });
const reloaded = await page.evaluate(() => {
  const view = window.composerTest.engine.getSnapshot();
  return { count: view.state.submissions.length, status: view.state.submissions[0]?.status, text: view.state.submissions[0]?.snapshot?.text };
});
check('reload 后 Outbox 恢复', reloaded.count > 0 && reloaded.status === 'accepted', JSON.stringify(reloaded));
check('reload 后文本正确', reloaded.text === '你好 Bridge', reloaded.text);

// 无未捕获错误
check('无未捕获页面错误', errors.length === 0, JSON.stringify(errors));

const failed = results.filter((item) => !item.pass);
for (const item of results) console.log(`${item.pass ? '✔' : '✖'} ${item.name}${item.pass ? '' : ` — ${item.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
await server.close();
process.exit(failed.length ? 1 : 0);
