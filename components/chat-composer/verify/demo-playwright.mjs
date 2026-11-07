import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium as installedChromium } from 'playwright-core';
import { startDemoServer } from './demo-server.mjs';

let server;
let browser;
before(async () => {
  server = await startDemoServer();
  const chromium = process.env.CE_PLAYWRIGHT_PATH
    ? createRequire(import.meta.url)(process.env.CE_PLAYWRIGHT_PATH).chromium : installedChromium;
  browser = await chromium.launch({ channel: process.env.CE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function openPage(t, { editor = 'text', context, scope = crypto.randomUUID() } = {}) {
  const owned = !context;
  context ??= await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  t.after(async () => { assert.deepEqual(errors, [], 'No uncaught React/browser errors'); if (owned) await context.close(); else await page.close(); });
  await page.goto(`${server.url}?scope=${encodeURIComponent(scope)}&editor=${editor}&timeout=5000`);
  await page.waitForFunction(() => Boolean(window.composerTest));
  return { page, context, scope };
}
const editorOf = (page) => page.getByTestId('editor');
const textOf = (page) => page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.text);
const rowsOf = (page) => page.evaluate(() => window.composerTest.engine.getSnapshot().state.submissions.map(({ id, status, snapshot }) => ({ id, status, text: snapshot.text })));
async function type(page, text) {
  await editorOf(page).fill(text);
  await page.waitForFunction((text) => {
    const view = window.composerTest.engine.getSnapshot();
    return view.state.draft.snapshot.text === text && !view.dirty;
  }, text);
}
async function waitStatus(page, status, index = 0) {
  await page.waitForFunction(({ status, index }) => window.composerTest.engine.getSnapshot().state.submissions[index]?.status === status, { status, index });
}
async function messages(page, scope) {
  return page.evaluate(async (scope) => (await (await fetch('api/stats')).json()).messages.filter((message) => message.scopeId === scope), scope);
}
async function send(page, text, scenario = 'normal') {
  await page.getByTestId('scenario').selectOption(scenario);
  await type(page, text);
  await editorOf(page).press('Enter');
}
async function held(page) {
  await page.waitForFunction(async () => (await (await fetch('api/stats')).json()).held > 0);
}

test('B01: real React double Enter during a held receipt sends A exactly once with no leftover line', async (t) => {
  const { page, scope } = await openPage(t);
  await send(page, 'A', 'hold');
  await held(page);
  assert.equal(await textOf(page), '');
  await editorOf(page).press('Enter');
  assert.equal(await textOf(page), '');
  await page.getByTestId('release').click();
  await waitStatus(page, 'accepted');
  assert.equal((await messages(page, scope)).length, 1);
  assert.equal(await editorOf(page).inputValue(), '');
});

for (const text of ['B-new', 'A', ' \n']) {
  test(`B02: late admission preserves the successor draft ${JSON.stringify(text)}`, async (t) => {
    const { page } = await openPage(t);
    await send(page, 'A', 'hold'); await held(page);
    await type(page, text);
    await page.getByTestId('release').click(); await waitStatus(page, 'accepted');
    assert.equal(await textOf(page), text);
    await page.reload(); await page.waitForFunction(() => Boolean(window.composerTest));
    assert.equal(await textOf(page), text);
  });
}

test('B03: actual lost HTTP acknowledgement is unknown; lookup confirms without a second send', async (t) => {
  const { page, scope } = await openPage(t);
  await send(page, 'only once', 'lost-ack');
  await waitStatus(page, 'unknown');
  assert.equal(await textOf(page), '');
  assert.equal(await page.getByRole('button', { name: '原样重试' }).count(), 0);
  await page.getByRole('button', { name: '核对送达状态' }).click();
  await waitStatus(page, 'accepted');
  assert.equal((await messages(page, scope)).length, 1);
});

test('B04: renderer restart keeps uncertain A and new draft B in actual IndexedDB', async (t) => {
  const { page, scope } = await openPage(t);
  await send(page, 'A', 'hold'); await held(page);
  await type(page, 'B');
  await page.reload(); await page.waitForFunction(() => Boolean(window.composerTest));
  await waitStatus(page, 'unknown');
  assert.equal(await textOf(page), 'B');
  assert.equal((await messages(page, scope)).length, 1);
  await page.getByRole('button', { name: '核对送达状态' }).click(); await waitStatus(page, 'accepted');
  assert.equal(await textOf(page), 'B');
});

test('B05: explicit rejection has a separate recovery action and cannot replace whitespace or B', async (t) => {
  const { page } = await openPage(t);
  await send(page, 'A', 'reject'); await waitStatus(page, 'rejected');
  assert.equal(await textOf(page), '');
  await type(page, 'B');
  assert.equal(await page.getByRole('button', { name: '取回编辑', exact: true }).isDisabled(), true);
  await type(page, ' \n');
  assert.equal(await page.getByRole('button', { name: '取回编辑', exact: true }).isDisabled(), true);
  await type(page, '');
  await page.getByRole('button', { name: '取回编辑', exact: true }).click();
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.text === 'A');
  assert.equal((await rowsOf(page))[0].status, 'cancelled');
});

test('B06: actual Lexical mention + file bytes restore together and survive a reload', async (t) => {
  const { page } = await openPage(t, { editor: 'rich' });
  await page.getByTestId('mention').click();
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.references.length === 1);
  await page.getByTestId('files').setInputFiles({ name: '资料.txt', mimeType: 'text/plain', buffer: Buffer.from('真实附件字节') });
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot(); return !view.dirty && view.state.draft.snapshot.attachments.length === 1;
  });
  await page.getByTestId('scenario').selectOption('reject');
  await editorOf(page).press('Enter'); await waitStatus(page, 'rejected');
  assert.equal(await textOf(page), '');
  await page.getByRole('button', { name: '取回编辑', exact: true }).click();
  await page.locator('[data-testid=editor] .mention').waitFor();
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.attachments[0].data.text()), '真实附件字节');
  await page.reload(); await page.waitForFunction(() => Boolean(window.composerTest));
  await page.locator('[data-testid=editor] .mention').waitFor();
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.attachments[0].data.text()), '真实附件字节');
});

test('B07: attachment-only submission owns the bytes once and has no residual editor attachment', async (t) => {
  const { page, scope } = await openPage(t);
  await page.getByTestId('files').setInputFiles({ name: 'only.txt', mimeType: 'text/plain', buffer: Buffer.from('only-file') });
  await page.waitForFunction(() => !window.composerTest.engine.getSnapshot().dirty);
  await editorOf(page).press('Enter'); await waitStatus(page, 'accepted');
  const records = await messages(page, scope);
  assert.equal(records.length, 1);
  assert.equal(Buffer.from(records[0].snapshot.attachments[0].bytes, 'base64').toString(), 'only-file');
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.attachments.length), 0);
});

test('B08: FIFO advances one turn at a time; Up removes only the latest queued message', async (t) => {
  const { page, scope } = await openPage(t);
  await send(page, 'A'); await waitStatus(page, 'accepted');
  await send(page, 'B'); await waitStatus(page, 'queued', 1);
  await send(page, 'C'); await waitStatus(page, 'queued', 2);
  await editorOf(page).press('ArrowUp');
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.text === 'C');
  assert.equal((await rowsOf(page))[2].status, 'cancelled');
  await editorOf(page).press('Enter'); await waitStatus(page, 'queued', 3);
  await page.getByTestId('end-turn').click(); await waitStatus(page, 'accepted', 1);
  assert.deepEqual((await messages(page, scope)).map((message) => message.snapshot.text), ['A', 'B']);
  await page.getByTestId('end-turn').click(); await waitStatus(page, 'accepted', 3);
  assert.deepEqual((await messages(page, scope)).map((message) => message.snapshot.text), ['A', 'B', 'C']);
});

test('B09: steer reaches the existing turn and none leaves input unchanged', async (t) => {
  const { page, scope } = await openPage(t);
  await send(page, 'A'); await waitStatus(page, 'accepted');
  await page.getByTestId('busy-mode').selectOption('steer');
  await send(page, 'S'); await waitStatus(page, 'accepted', 1);
  const records = await messages(page, scope);
  assert.equal(records[1].delivery, 'steer');
  assert.equal(records[1].turnId, `turn-${records[0].id}`);
  await page.getByTestId('busy-mode').selectOption('none');
  await send(page, 'keep');
  assert.equal(await textOf(page), 'keep');
  assert.equal((await messages(page, scope)).length, 2);
});

test('B10: injected IndexedDB boundary failure keeps A and sends no request', async (t) => {
  const { page, scope } = await openPage(t);
  await type(page, 'A');
  await page.evaluate(() => window.composerTest.failWrite());
  await page.getByTestId('send').click();
  await page.getByTestId('storage-error').waitFor();
  assert.equal(await textOf(page), 'A');
  assert.equal((await messages(page, scope)).length, 0);
  assert.equal((await rowsOf(page)).length, 0);
  await page.getByTestId('send').click(); await waitStatus(page, 'accepted');
  assert.equal((await messages(page, scope)).length, 1);
});

test('B11: local transaction gate is read-only only until payload ownership commits', async (t) => {
  const { page, scope } = await openPage(t);
  await type(page, 'A');
  await page.evaluate(() => window.composerTest.holdWrite());
  await editorOf(page).press('Enter');
  await page.waitForFunction(() => window.composerTest.writeGateHit);
  assert.equal(await editorOf(page).getAttribute('readonly'), '');
  assert.equal((await messages(page, scope)).length, 0);
  await editorOf(page).press('Enter');
  await page.evaluate(() => window.composerTest.releaseWrite()); await waitStatus(page, 'accepted');
  assert.equal((await messages(page, scope)).length, 1);
  assert.equal(await textOf(page), '');
});

test('B12: Shift+Enter is a real newline; composition confirmation and held-key repeat do not submit', async (t) => {
  const { page, scope } = await openPage(t);
  await type(page, 'L1');
  await editorOf(page).press('Shift+Enter'); await page.keyboard.type('L2');
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.text === 'L1\nL2');
  await editorOf(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal((await rowsOf(page)).length, 0);
  // 组合刚结束的 10ms 宽限期内，普通 Enter 也不提交：三个事件必须在同一个 JS tick 里派发，
  // 保证 compositionend 与 Enter 的间隔小于宽限窗口（跨 Playwright 调用会超过 10ms，测不到窗口）。
  await page.evaluate(() => {
    const editor = document.querySelector('[data-testid=editor]');
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'A' }));
    editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'A' }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
  assert.equal((await rowsOf(page)).length, 0);
  assert.equal(await textOf(page), 'L1\nL2');
  await page.getByTestId('scenario').selectOption('hold');
  await page.keyboard.down('Enter'); await page.keyboard.down('Enter'); await page.keyboard.up('Enter');
  await held(page); await page.getByTestId('release').click(); await waitStatus(page, 'accepted');
  assert.equal((await messages(page, scope)).length, 1);
});

test('B13: stale tabs cannot overwrite each other in actual IndexedDB', async (t) => {
  const first = await openPage(t);
  const second = await openPage(t, { context: first.context, scope: first.scope });
  await type(first.page, 'A');
  await editorOf(second.page).fill('B');
  await second.page.getByTestId('storage-error').waitFor();
  assert.equal(await textOf(second.page), 'B');
  assert.equal(await first.page.evaluate(async () => (await window.composerTest.store.read(window.composerTest.engine.getSnapshot().state.scopeId)).draft.snapshot.text), 'A');
});

test('B14: StrictMode retry uses the same ID and does not dispatch from a React updater', async (t) => {
  const { page, scope } = await openPage(t);
  await send(page, 'A', 'reject'); await waitStatus(page, 'rejected');
  const id = (await rowsOf(page))[0].id;
  await page.getByTestId('scenario').selectOption('normal');
  await page.getByRole('button', { name: '原样重试' }).click(); await waitStatus(page, 'accepted');
  assert.equal((await rowsOf(page)).length, 1);
  assert.equal((await messages(page, scope))[0].id, id);
});

test('B15: ordinary Lexical edits preserve references owned by external integrations', async (t) => {
  const { page } = await openPage(t, { editor: 'rich' });
  await page.evaluate(async () => {
    const engine = window.composerTest.engine;
    const snapshot = structuredClone(engine.getSnapshot().state.draft.snapshot);
    snapshot.references.push({ id: 'external-comment', kind: 'code-comment', value: { path: 'a.ts', line: 2 } });
    await engine.edit(snapshot);
  });
  await editorOf(page).click(); await page.keyboard.type('A');
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.text === 'A');
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.references.some((item) => item.id === 'external-comment')), true);
});

test('B16: undo cannot resurrect a submitted Lexical message into its successor draft', async (t) => {
  const { page } = await openPage(t, { editor: 'rich' });
  await page.getByTestId('scenario').selectOption('hold');
  await editorOf(page).click(); await page.keyboard.type('A');
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.text === 'A' && !window.composerTest.engine.getSnapshot().dirty);
  await editorOf(page).press('Enter'); await held(page);
  assert.equal(await textOf(page), '');
  await editorOf(page).press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await textOf(page), '');
  await page.getByTestId('release').click(); await waitStatus(page, 'accepted');
});

test('B17: failed receipt persistence retries only the local write and preserves B', async (t) => {
  const { page, scope } = await openPage(t);
  await send(page, 'A', 'hold'); await held(page);
  await type(page, 'B');
  await page.evaluate(() => window.composerTest.failWrite());
  await page.getByTestId('release').click();
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().pendingReceipts === 1 && Boolean(window.composerTest.engine.getSnapshot().error));
  assert.equal(await textOf(page), 'B');
  await page.getByRole('button', { name: '重试本地保存' }).click(); await waitStatus(page, 'accepted');
  assert.equal(await textOf(page), 'B');
  assert.equal((await messages(page, scope)).length, 1);
});

test('B18: an actual renderer crash retains the uncertain message and the durable successor draft', async (t) => {
  const { page, context, scope } = await openPage(t);
  await send(page, 'A', 'hold'); await held(page); await type(page, 'B');
  // Page.crash 偶发注入未命中（CDP 会话/负载时序）；每次尝试新建 CDP 会话，最多 3 次。
  let timer;
  const crashed = new Promise((resolve) => page.once('crash', () => resolve(true)));
  let observed = false;
  for (let attempt = 0; attempt < 3 && !observed; attempt++) {
    const session = await context.newCDPSession(page);
    void session.send('Page.crash').catch(() => {});
    observed = await Promise.race([crashed, new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 2000);
    })]);
    clearTimeout(timer);
  }
  assert.equal(observed, true, 'The crash injection must actually hit the renderer');
  await page.close();
  const { page: restored } = await openPage(t, { context, scope });
  await waitStatus(restored, 'unknown');
  assert.equal(await textOf(restored), 'B');
  await restored.getByRole('button', { name: '核对送达状态' }).click(); await waitStatus(restored, 'accepted');
  assert.equal((await messages(restored, scope)).length, 1);
});

test('B19: the executable host deduplicates admitted IDs and refuses a changed payload under the same ID', async (t) => {
  const { page, scope } = await openPage(t);
  await send(page, 'A'); await waitStatus(page, 'accepted');
  const [stored] = await messages(page, scope);
  const results = await page.evaluate(async (stored) => {
    const { hash, ...payload } = stored;
    const post = async (body) => (await fetch('api/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': body.id }, body: JSON.stringify(body),
    })).json();
    const duplicate = await post(payload);
    const conflicting = await post({ ...payload, snapshot: { ...payload.snapshot, text: 'different content' } });
    return { duplicate, conflicting };
  }, stored);
  assert.equal(results.duplicate.status, 'accepted');
  assert.equal(results.conflicting.status, 'unknown');
  assert.equal((await messages(page, scope)).length, 1);
});

// 有序文档形状：正文与附件节点按文档顺序交织（空文本节点不是内容，不参与断言）。
const orderedOf = (page, index = 0) => page.evaluate((index) => {
  const records = index === null
    ? [window.composerTest.engine.getSnapshot().state.draft.snapshot]
    : [window.composerTest.engine.getSnapshot().state.submissions[index]?.snapshot].filter(Boolean);
  return records.map((snapshot) => snapshot.document.value.root.children[0].children
    .filter((node) => node.type !== 'text' || node.text)
    .map((node) => node.type).join('|'));
}, index);
const attachmentNodeIdOf = (page) => page.evaluate(() => {
  const children = window.composerTest.engine.getSnapshot().state.draft.snapshot.document.value.root.children[0].children;
  return children.find((node) => node.type === 'composer-attachment')?.nodeId;
});

test('B20: an attachment node keeps its place between words across reload, and double submit never duplicates it', async (t) => {
  const { page, scope } = await openPage(t, { editor: 'rich' });
  await editorOf(page).click();
  await page.keyboard.type('AB');
  await editorOf(page).press('ArrowLeft');
  await page.getByTestId('files').setInputFiles({ name: '卡片.png', mimeType: 'image/png', buffer: Buffer.from('png-bytes') });
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    const children = view.state.draft.snapshot.document?.value?.root?.children?.[0]?.children ?? [];
    return !view.dirty && view.state.draft.snapshot.attachments.length === 1
      && children.some((node) => node.type === 'composer-attachment');
  });
  assert.deepEqual(await orderedOf(page, null), ['text|composer-attachment|text']);
  assert.equal(await page.locator('[data-testid=editor] .attachment').count(), 1);
  const nodeId = await attachmentNodeIdOf(page);
  // 刷新后草稿从 IndexedDB 恢复：有序内容与 NodeId 原样回来。
  await page.reload(); await page.waitForFunction(() => Boolean(window.composerTest));
  await page.locator('[data-testid=editor] .attachment').waitFor();
  assert.deepEqual(await orderedOf(page, null), ['text|composer-attachment|text']);
  assert.equal(await attachmentNodeIdOf(page), nodeId);
  // 暂扣回执时提交；再按一次 Enter 不得产生第二条消息或重复附件。
  await page.getByTestId('scenario').selectOption('hold');
  await editorOf(page).press('Enter'); await held(page);
  await editorOf(page).press('Enter');
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.submissions.length), 1);
  await page.getByTestId('release').click(); await waitStatus(page, 'accepted');
  assert.equal(await textOf(page), '');
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.attachments.length), 0);
  const records = await messages(page, scope);
  assert.equal(records.length, 1);
  const sent = records[0].snapshot;
  assert.equal(sent.document.value.root.children[0].children
    .filter((node) => node.type === 'composer-attachment').length, 1);
  assert.equal(sent.attachments.length, 1);
  assert.equal(Buffer.from(sent.attachments[0].bytes, 'base64').toString(), 'png-bytes');
});

test('B21: textarea mode keeps attachments rail-only — file add creates no ordered document', async (t) => {
  const { page, scope } = await openPage(t, { editor: 'text' });
  await page.getByTestId('files').setInputFiles({ name: 'rail.txt', mimeType: 'text/plain', buffer: Buffer.from('rail') });
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return !view.dirty && view.state.draft.snapshot.attachments.length === 1;
  });
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.document), undefined);
  await editorOf(page).press('Enter'); await waitStatus(page, 'accepted');
  const records = await messages(page, scope);
  assert.equal(records.length, 1);
  assert.equal(records[0].snapshot.document, undefined);
  assert.equal(Buffer.from(records[0].snapshot.attachments[0].bytes, 'base64').toString(), 'rail');
});

test('B22: @ menu pick inserts a reference node in one undo step, then Enter submits once', async (t) => {
  const { page, scope } = await openPage(t, { editor: 'rich' });
  await editorOf(page).click();
  await page.keyboard.type('@fi');
  await page.getByTestId('candidate-menu').waitFor();
  await page.waitForFunction(() => {
    const options = [...document.querySelectorAll('[data-testid=candidate-option]')];
    return options.map((option) => option.textContent).join(',') === 'field-report.md,final-notes.md';
  });
  // 第一个候选自动高亮；↓ 移动共享高亮后 Enter 只确认菜单项。
  await editorOf(page).press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('[data-testid=candidate-option][aria-selected="true"]')?.textContent === 'final-notes.md');
  await editorOf(page).press('Enter');
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.references.length === 1);
  assert.equal(await page.locator('[data-testid=editor] .mention').count(), 1);
  // 一次选择一次 Undo：一步撤销回到触发文本本身；同身份命中被抑制，菜单不立刻弹回。
  await editorOf(page).press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return view.state.draft.snapshot.text === '@fi' && view.state.draft.snapshot.references.length === 0;
  });
  await page.waitForFunction(() => !document.querySelector('[data-testid=candidate-menu]'));
  // 重新补全：查询身份变化后菜单重新出现，Enter 接受自动高亮的首个候选。
  await page.keyboard.press('Backspace');
  await page.getByTestId('candidate-menu').waitFor();
  await page.keyboard.type('i');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=candidate-option]').length === 2);
  await editorOf(page).press('Enter');
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.references.length === 1);
  // 菜单已随选择关闭：现在 Enter 是发送，重复 Enter 不产生第二条消息。
  await page.getByTestId('scenario').selectOption('hold');
  await editorOf(page).press('Enter'); await held(page);
  await editorOf(page).press('Enter');
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.submissions.length), 1);
  await page.getByTestId('release').click(); await waitStatus(page, 'accepted');
  const records = await messages(page, scope);
  assert.equal(records.length, 1);
  const sent = records[0].snapshot;
  assert.equal(sent.references.length, 1);
  assert.equal(sent.references[0].value.label, '@field-report.md');
  // 有序文档：mention 芯片 + 补尾空格按真实顺序保留到送达载荷。
  assert.deepEqual(await orderedOf(page, 0), ['composer-mention|text']);
});

test('B23: stale query results are unpickable — slow old query is ignored, pending Enter never submits', async (t) => {
  const { page, scope } = await openPage(t, { editor: 'rich' });
  // 演示覆盖钩子注入慢/快候选源替身：s1 查询最慢（800ms），s2 查询 300ms，其余 120ms。
  await page.evaluate(() => window.composerTest.setCompletionProvider((kind, query) => new Promise((resolve) => {
    const source = kind === 'reference'
      ? [{ label: 's1-alpha.md', insertText: '@s1-alpha.md' }, { label: 's2-beta.md', insertText: '@s2-beta.md' }]
      : [];
    const delay = query === 's1' ? 800 : query === 's2' ? 300 : 120;
    setTimeout(() => resolve(source.filter((item) => item.label.includes(query))), delay);
  })));
  await editorOf(page).click();
  await page.keyboard.type('@s1');
  // 快速回退一位并输入 2：查询 s1 → s → s2 连续换代，慢的 s1 结果稍后才会到达。
  await page.keyboard.press('Backspace');
  await page.keyboard.type('2');
  // 当前查询 s2 尚未就绪（pending）：菜单开着，Enter 只确认菜单，绝不发送。
  await page.getByTestId('candidate-menu').waitFor();
  await editorOf(page).press('Enter');
  assert.equal((await rowsOf(page)).length, 0);
  assert.equal((await messages(page, scope)).length, 0);
  // s2 结果就绪后菜单里只有它；再等足慢查询的时限，s1 的迟到结果也不得混入。
  await page.waitForFunction(() => {
    const options = [...document.querySelectorAll('[data-testid=candidate-option]')];
    return options.length === 1 && options[0].textContent === 's2-beta.md';
  });
  await page.waitForTimeout(1000);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-testid=candidate-option]')].map((option) => option.textContent)), ['s2-beta.md']);
  // 首个（唯一）候选自动高亮：Enter 选中 s2，写回 mention 芯片。
  await editorOf(page).press('Enter');
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.references.length === 1);
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.references[0].value.label), '@s2-beta.md');
  await page.getByTestId('scenario').selectOption('hold');
  await editorOf(page).press('Enter'); await held(page);
  await page.getByTestId('release').click(); await waitStatus(page, 'accepted');
  const records = await messages(page, scope);
  assert.equal(records.length, 1);
  assert.equal(records[0].snapshot.references.length, 1);
  assert.deepEqual(await orderedOf(page, 0), ['composer-mention|text']);
});

// 统一准入（步骤 4）：粘贴/拖放的 DataTransfer 全部在页面内用构造器合成（ClipboardEvent/
// DragEvent 的 init 都带 dataTransfer），三个入口共用 ChatComposer 的 runIntake。
// files: [{ name, type, data?, size? }]（data 为文本内容；size 为随机字节数，用于超大文件）。
const pasteWith = (page, files, text) => page.evaluate(({ files, text }) => {
  const transfer = new DataTransfer();
  for (const { name, type, data, size } of files) {
    transfer.items.add(new File([data ?? new Uint8Array(size ?? 0)], name, { type }));
  }
  if (text !== undefined) transfer.setData('text/plain', text);
  document.querySelector('[data-testid=editor]').dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
}, { files, text });

test('B24: pasting a file on the rich editor intakes it — card, node at cursor, bytes submitted', async (t) => {
  const { page, scope } = await openPage(t, { editor: 'rich' });
  await editorOf(page).click();
  await page.keyboard.type('前');
  await pasteWith(page, [{ name: '粘贴.png', type: 'image/png', data: '粘贴字节' }]);
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return !view.dirty && view.state.draft.snapshot.attachments.length === 1;
  });
  // 图片缩略图卡片出现；有序文档在光标处（'前' 之后）获得附件节点。
  assert.equal(await page.locator('[data-testid=attachment-thumb]').count(), 1);
  assert.equal(await page.locator('[data-testid=editor] .attachment').count(), 1);
  assert.deepEqual(await orderedOf(page, null), ['text|composer-attachment']);
  await page.getByTestId('scenario').selectOption('hold');
  await editorOf(page).press('Enter'); await held(page);
  await page.getByTestId('release').click(); await waitStatus(page, 'accepted');
  const records = await messages(page, scope);
  assert.equal(records.length, 1);
  assert.equal(Buffer.from(records[0].snapshot.attachments[0].bytes, 'base64').toString(), '粘贴字节');
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.attachments.length), 0);
});

test('B25: pasting text and a file together lands both — text inserted, card present', async (t) => {
  const { page } = await openPage(t, { editor: 'rich' });
  await editorOf(page).click();
  await pasteWith(page, [{ name: '双份.txt', type: 'text/plain', data: '文件字节' }], '正文粘贴');
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return !view.dirty && view.state.draft.snapshot.attachments.length === 1
      && view.state.draft.snapshot.text === '正文粘贴';
  });
  assert.equal(await page.locator('[data-testid=attachment-card]').count(), 1);
  // 文件先准入，text/plain 原文随后插入；附件节点最终落在选区末端之后。
  assert.deepEqual(await orderedOf(page, null), ['text|composer-attachment']);
});

test('B26: document drop shows the overlay, drop adds card and node, and no stuck overlay remains', async (t) => {
  const { page, scope } = await openPage(t, { editor: 'rich' });
  await editorOf(page).click();
  await page.keyboard.type('AB');
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['拖入字节'], '拖入.txt', { type: 'text/plain' }));
    document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await page.getByTestId('drop-overlay').waitFor();
  // dragover 由文档级监听处理：处理器跑了（defaultPrevented）且处于接纳态（遮罩文案）。
  // 合成事件的 DataTransfer.dropEffect 读回是 Chromium 实现细节——真实拖拽会话才兑现，
  // DSH 也不对合成事件断言它，故不作为契约。
  const state = await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['拖入字节'], '拖入.txt', { type: 'text/plain' }));
    const event = new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      overlayText: document.querySelector('[data-testid=drop-overlay]')?.textContent ?? '',
    };
  });
  assert.equal(state.defaultPrevented, true);
  assert.ok(state.overlayText.includes('松开鼠标'), state.overlayText);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['拖入字节'], '拖入.txt', { type: 'text/plain' }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return !view.dirty && view.state.draft.snapshot.attachments.length === 1;
  });
  assert.equal(await page.locator('[data-testid=attachment-card]').count(), 1);
  assert.deepEqual(await orderedOf(page, null), ['text|composer-attachment']);
  // dragDepth 已随 drop 重置：遮罩不得残留（否则后续真实拖拽的计数会错）。
  assert.equal(await page.locator('[data-testid=drop-overlay]').count(), 0);
  await page.getByTestId('scenario').selectOption('hold');
  await editorOf(page).press('Enter'); await held(page);
  await page.getByTestId('release').click(); await waitStatus(page, 'accepted');
  const records = await messages(page, scope);
  assert.equal(Buffer.from(records[0].snapshot.attachments[0].bytes, 'base64').toString(), '拖入字节');
});

test('B27: policy rejection warns with names and reasons; accepted siblings are still added', async (t) => {
  const { page } = await openPage(t, { editor: 'rich' });
  await editorOf(page).click();
  // 演示策略：单文件 2 MiB 上限。3 MiB 的文件按单文件大小只拒绝自己；同批正常文件照常进入。
  await pasteWith(page, [
    { name: '超大.png', type: 'image/png', size: 3 * 1024 * 1024 },
    { name: '正常.txt', type: 'text/plain', data: 'ok' },
  ]);
  await page.getByTestId('intake-warning').waitFor();
  const warning = await page.getByTestId('intake-warning').textContent();
  assert.match(warning, /超大\.png/);
  assert.match(warning, /超过单个文件大小上限/);
  assert.doesNotMatch(warning, /正常\.txt/);
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return !view.dirty && view.state.draft.snapshot.attachments.length === 1;
  });
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.attachments[0].name), '正常.txt');
  assert.equal(await page.locator('[data-testid=attachment-card]').count(), 1);
  // 警告可关闭；拒绝不阻塞发送——正常文件随消息成功送达。
  await page.getByTestId('intake-dismiss').click();
  assert.equal(await page.locator('[data-testid=intake-warning]').count(), 0);
  await page.getByTestId('scenario').selectOption('normal');
  await editorOf(page).press('Enter'); await waitStatus(page, 'accepted');
});
