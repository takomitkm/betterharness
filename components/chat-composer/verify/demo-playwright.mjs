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
// 整篇文档读取：各段落的行内序列按「||」连接——单段落文档的断言字符串与只读首段时一致。
const orderedOf = (page, index = 0) => page.evaluate((index) => {
  const records = index === null
    ? [window.composerTest.engine.getSnapshot().state.draft.snapshot]
    : [window.composerTest.engine.getSnapshot().state.submissions[index]?.snapshot].filter(Boolean);
  return records.map((snapshot) => snapshot.document.value.root.children
    .map((paragraph) => paragraph.children
      .filter((node) => node.type !== 'text' || node.text)
      .map((node) => node.type).join('|'))
    .join('||'));
}, index);
// 全部附件节点的身份（文档顺序，跨所有段落）：Node/AssetId 随移动与重排保持不变。
const attachmentNodesOf = (page) => page.evaluate(() => {
  const nodes = [];
  for (const paragraph of window.composerTest.engine.getSnapshot().state.draft.snapshot.document.value.root.children) {
    for (const node of paragraph.children) {
      if (node.type === 'composer-attachment') nodes.push({ nodeId: node.nodeId, assetId: node.assetId });
    }
  }
  return nodes;
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
  const nodes = await attachmentNodesOf(page);
  // 刷新后草稿从 IndexedDB 恢复：有序内容与 NodeId 原样回来。
  await page.reload(); await page.waitForFunction(() => Boolean(window.composerTest));
  await page.locator('[data-testid=editor] .attachment').waitFor();
  assert.deepEqual(await orderedOf(page, null), ['text|composer-attachment|text']);
  assert.deepEqual(await attachmentNodesOf(page), nodes);
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
  const { page, scope } = await openPage(t, { editor: 'rich' });
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

// 步骤 5（正文附件移动）的共同开场：B20 式真实插入（A|B 之间）得到第一个附件节点，
// 再经真实同步路径（engine.edit → validateSnapshot → composer-sync 整体替换，B15 同款）
// 补出第二个真实段落与第二个附件。打字造不出真实段落：Enter 会提交，Shift+Enter 只是
// 段内 LineBreakNode。「移动到末位」需要跨段落目标，所以文档必须有两个真实段落。
const ORIGINAL_ORDER = 'text|composer-attachment|text||text|composer-attachment';
// 移动后第一段剩 A、B 两个相邻 TextNode：Lexical 在 update 收尾的规范化会把同格式
// 相邻文本节点合并成一个「AB」，所以期望是单个 text，而不是「text|text」。
const MOVED_ORDER = 'text||text|composer-attachment|composer-attachment';
const setupTwoParagraphAttachments = async (page, firstName, secondName) => {
  await editorOf(page).click();
  await page.keyboard.type('AB');
  await editorOf(page).press('ArrowLeft');
  await page.getByTestId('files').setInputFiles({ name: firstName, mimeType: 'image/png', buffer: Buffer.from(`${firstName}-bytes`) });
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return !view.dirty && view.state.draft.snapshot.attachments.length === 1
      && (view.state.draft.snapshot.document?.value?.root?.children?.[0]?.children ?? [])
        .some((node) => node.type === 'composer-attachment');
  });
  const ids = await page.evaluate(async ({ firstName, secondName }) => {
    const engine = window.composerTest.engine;
    const snapshot = structuredClone(engine.getSnapshot().state.draft.snapshot);
    const firstNode = snapshot.document.value.root.children[0].children.find((node) => node.type === 'composer-attachment');
    const secondAsset = { id: crypto.randomUUID(), name: secondName, mediaType: 'text/plain', data: new Blob([`${secondName}-bytes`]) };
    const secondNodeId = crypto.randomUUID();
    snapshot.attachments.push(secondAsset);
    snapshot.document.value.root.children.push({
      type: 'paragraph', version: 1, direction: null, format: '', indent: 0,
      children: [
        { detail: 0, format: 0, mode: 'normal', style: '', text: 'CD', type: 'text', version: 1 },
        { type: 'composer-attachment', version: 1, nodeId: secondNodeId, assetId: secondAsset.id },
      ],
    });
    await engine.edit(snapshot);
    return { movedNodeId: firstNode.nodeId, movedAssetId: firstNode.assetId, tailNodeId: secondNodeId, tailAssetId: secondAsset.id };
  }, { firstName, secondName });
  // 等编辑器本体也完成 composer-sync 整体替换：后续 moveAttachmentNode 读的是编辑器文档，
  // 不能在引擎已更新、编辑器未同步的窗口里开跑（此前这段写在 return 之后，从未执行）。
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=editor] .composer-paragraph').length === 2
    && document.querySelectorAll('[data-testid=editor] .attachment').length === 2);
  return ids;
};
// 草稿文档顺序（整篇）达到期望且已落盘。
const draftOrderIs = (page, order) => page.waitForFunction((order) => {
  const view = window.composerTest.engine.getSnapshot();
  if (view.dirty) return false;
  const document = view.state.draft.snapshot.document;
  if (!document) return false;
  return document.value.root.children
    .map((paragraph) => paragraph.children
      .filter((node) => node.type !== 'text' || node.text)
      .map((node) => node.type).join('|'))
    .join('||') === order;
}, order);

test('B28: moveAttachmentNode repositions an attachment across paragraphs in one undo step; payload keeps the order', async (t) => {
  const { page, scope } = await openPage(t, { editor: 'rich' });
  const ids = await setupTwoParagraphAttachments(page, '卡片.png', '尾件.txt');
  const originalNodes = [
    { nodeId: ids.movedNodeId, assetId: ids.movedAssetId },
    { nodeId: ids.tailNodeId, assetId: ids.tailAssetId },
  ];
  await draftOrderIs(page, ORIGINAL_ORDER);
  assert.deepEqual(await attachmentNodesOf(page), originalNodes);
  // 编程路径（window.composerTest.moveAttachment → 注册的 mover → moveAttachmentNode）：
  // 唯一移动对象移到附件序列第 1 位（末位）——跨段落插到第二个段落的最后一个附件之后。
  await page.evaluate(({ assetId }) => window.composerTest.moveAttachment(assetId, 1), { assetId: ids.movedAssetId });
  await draftOrderIs(page, MOVED_ORDER);
  // 节点身份原样存活；attachments 列表（rail 顺序）不动——移动只改文档顺序。
  const nodesAfterMove = [
    { nodeId: ids.tailNodeId, assetId: ids.tailAssetId },
    { nodeId: ids.movedNodeId, assetId: ids.movedAssetId },
  ];
  assert.deepEqual(await attachmentNodesOf(page), nodesAfterMove);
  assert.deepEqual(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.attachments.map((item) => item.name)), ['卡片.png', '尾件.txt']);
  // 一步 Undo：整步移动一次撤回（若移动拆成多次 update，此处会是中间态而非原序）。
  await editorOf(page).press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await draftOrderIs(page, ORIGINAL_ORDER);
  assert.deepEqual(await attachmentNodesOf(page), originalNodes);
  // rail「后移」按钮走同一条注册的 mover：目标下标由文档顺序换算（0 → 1）。
  await page.getByRole('button', { name: '后移 卡片.png' }).click();
  await draftOrderIs(page, MOVED_ORDER);
  assert.deepEqual(await attachmentNodesOf(page), nodesAfterMove);
  // 暂扣回执提交：送达载荷保留移动后的整篇顺序与节点身份；附件列表顺序不变、字节齐全。
  await page.getByTestId('scenario').selectOption('hold');
  await editorOf(page).press('Enter'); await held(page);
  await page.getByTestId('release').click(); await waitStatus(page, 'accepted');
  const records = await messages(page, scope);
  assert.equal(records.length, 1);
  const sent = records[0].snapshot;
  assert.deepEqual(await orderedOf(page, 0), [MOVED_ORDER]);
  const sentNodes = await page.evaluate(() => {
    const nodes = [];
    for (const paragraph of window.composerTest.engine.getSnapshot().state.submissions[0].snapshot.document.value.root.children) {
      for (const node of paragraph.children) {
        if (node.type === 'composer-attachment') nodes.push({ nodeId: node.nodeId, assetId: node.assetId });
      }
    }
    return nodes;
  });
  assert.deepEqual(sentNodes, nodesAfterMove);
  assert.deepEqual(sent.attachments.map((item) => item.name), ['卡片.png', '尾件.txt']);
  assert.equal(Buffer.from(sent.attachments[0].bytes, 'base64').toString(), '卡片.png-bytes');
  assert.equal(Buffer.from(sent.attachments[1].bytes, 'base64').toString(), '尾件.txt-bytes');
});

test('B29: Ctrl/Cmd+Shift+Arrow moves the attachment the caret sits next to; one undo step restores', async (t) => {
  const { page } = await openPage(t, { editor: 'rich' });
  const ids = await setupTwoParagraphAttachments(page, '中卡.png', '尾行.txt');
  await draftOrderIs(page, ORIGINAL_ORDER);
  const originalNodes = await attachmentNodesOf(page);
  // 光标放到第一个附件节点紧邻处：点击第一段（落点在卡片附近，DOM 光标停在附件紧前或
  // 紧后的元素锚点），Home + 一次 → 后光标紧邻附件节点——$adjacentAttachmentOf 对紧前
  // （offset-1 处）与紧后（offset 处）都能解析到同一个节点，落点差异不影响移动目标。
  await page.locator('[data-testid=editor] .composer-paragraph').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+ArrowRight' : 'Control+Shift+ArrowRight');
  await draftOrderIs(page, MOVED_ORDER);
  // 节点身份原样存活。
  assert.deepEqual(await attachmentNodesOf(page), [
    { nodeId: ids.tailNodeId, assetId: ids.tailAssetId },
    { nodeId: ids.movedNodeId, assetId: ids.movedAssetId },
  ]);
  // 一步 Undo：整步移动一次撤回，文档顺序与节点身份都回来。
  await editorOf(page).press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await draftOrderIs(page, ORIGINAL_ORDER);
  assert.deepEqual(await attachmentNodesOf(page), originalNodes);
});

// —— 五项补强（2026-11-11）：剪贴板 MIME / alt 与原图开关 / 可见队列逐条取回 ——

test('B30: copying an attachment node writes the private MIME; pasting clones the reference with zero byte copy', async (t) => {
  const { page } = await openPage(t, { editor: 'rich' });
  await editorOf(page).click();
  await page.keyboard.type('AB');
  await page.locator('[data-testid=editor]').press('ArrowLeft');
  await page.getByTestId('files').setInputFiles({ name: 'clip.png', mimeType: 'image/png', buffer: Buffer.from('clip-bytes') });
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return !view.dirty && view.state.draft.snapshot.attachments.length === 1;
  });
  const assetId = await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.attachments[0].id);
  const originalNodeId = await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.document.value.root.children[0].children
    .find((node) => node.type === 'composer-attachment').nodeId);
  // 选中全文并复制：私有 MIME 携带附件 AssetId；Lexical 默认复制（text/html、text/plain）不受影响。
  await editorOf(page).press('Control+a');
  const mime = await page.evaluate(() => {
    const root = document.querySelector('[data-testid=editor]');
    const transfer = new DataTransfer();
    root.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
    return transfer.getData('application/x-betterharness-composer-attachment');
  });
  assert.deepEqual(JSON.parse(mime), [{ assetId }]);
  // 粘贴（选区仍为全选——方向键只动 DOM 选区，Lexical 内部选区滞后，B29 同款）：
  // 语义 = 替换选区为引用克隆：新 NodeId、同一 AssetId、attachments 列表零增长、字节不复制。
  await page.evaluate((mime) => {
    const root = document.querySelector('[data-testid=editor]');
    const transfer = new DataTransfer();
    transfer.setData('application/x-betterharness-composer-attachment', mime);
    root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, mime);
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return !view.dirty && view.state.draft.snapshot.document.value.root.children[0].children
      .filter((node) => node.type === 'composer-attachment').length === 1
      && view.state.draft.snapshot.document.value.root.children[0].children.length === 1;
  });
  const afterReplace = await page.evaluate(() => {
    const view = window.composerTest.engine.getSnapshot();
    const node = view.state.draft.snapshot.document.value.root.children[0].children[0];
    return { assetId: node.assetId, nodeId: node.nodeId, assetCount: view.state.draft.snapshot.attachments.length };
  });
  assert.equal(afterReplace.assetId, assetId);
  assert.notEqual(afterReplace.nodeId, originalNodeId);
  assert.equal(afterReplace.assetCount, 1);
  // 替换后选区已收缩到克隆节点之后：再贴一次 = 在光标处插入第二个引用克隆。
  await page.evaluate((mime) => {
    const root = document.querySelector('[data-testid=editor]');
    const transfer = new DataTransfer();
    transfer.setData('application/x-betterharness-composer-attachment', mime);
    root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, mime);
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return !view.dirty && view.state.draft.snapshot.document.value.root.children[0].children
      .filter((node) => node.type === 'composer-attachment').length === 2;
  });
  const cloned = await page.evaluate(() => {
    const view = window.composerTest.engine.getSnapshot();
    const nodes = view.state.draft.snapshot.document.value.root.children[0].children
      .filter((node) => node.type === 'composer-attachment')
      .map((node) => `${node.assetId}/${node.nodeId}`);
    return { nodes, assetCount: view.state.draft.snapshot.attachments.length, bytes: view.state.draft.snapshot.attachments[0].data.size };
  });
  assert.equal(new Set(cloned.nodes.map((entry) => entry.split('/')[0])).size, 1);
  assert.equal(new Set(cloned.nodes.map((entry) => entry.split('/')[1])).size, 2);
  assert.equal(cloned.assetCount, 1);
  assert.equal(cloned.bytes, 'clip-bytes'.length);
  // 负例：MIME 指向未知资产（跨草稿）→ 放弃 MIME 走常规路径，不造悬空引用。
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid=editor]');
    const transfer = new DataTransfer();
    transfer.setData('application/x-betterharness-composer-attachment', JSON.stringify([{ assetId: 'missing-asset' }]));
    root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.document.value.root.children[0].children
    .filter((node) => node.type === 'composer-attachment').length), 2);
});

test('B31: image card alt text and send-as-file toggle persist across reload and ride the submission', async (t) => {
  const { page, scope } = await openPage(t, { editor: 'rich' });
  await editorOf(page).click();
  await page.getByTestId('files').setInputFiles({ name: '猫.png', mimeType: 'image/png', buffer: Buffer.from('cat-bytes') });
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return !view.dirty && view.state.draft.snapshot.attachments.length === 1;
  });
  await page.getByTestId('attachment-alt').fill('一只猫');
  await page.getByTestId('attachment-send-as-file').click();
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    const attachment = view.state.draft.snapshot.attachments[0];
    return attachment.alt === '一只猫' && attachment.sendAsFile === true && !view.dirty;
  });
  // 刷新：元数据随草稿快照持久化，卡片控件回填。
  await page.reload(); await page.waitForFunction(() => Boolean(window.composerTest));
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.attachments.length === 1);
  assert.equal(await page.getByTestId('attachment-alt').inputValue(), '一只猫');
  assert.equal(await page.getByTestId('attachment-send-as-file').getAttribute('aria-pressed'), 'true');
  // 提交：载荷携带元数据。
  await page.getByTestId('scenario').selectOption('normal');
  await page.getByTestId('send').click();
  await waitStatus(page, 'accepted');
  const sent = (await messages(page, scope))[0].snapshot;
  assert.equal(sent.attachments[0].alt, '一只猫');
  assert.equal(sent.attachments[0].sendAsFile, true);
});

test('B32: queued rows get per-item recall — full snapshot returns to the draft and the row turns cancelled', async (t) => {
  const { page, scope } = await openPage(t);
  // 排队来源与 B08 同构：A 接纳后其轮次仍在运行，busy-mode=queue 下的新提交保持 queued
  //（sending 期间的提交按设计是 no-op，不会排队——见 FM01）。
  await send(page, 'A'); await waitStatus(page, 'accepted');
  await send(page, '第二条');
  await waitStatus(page, 'queued', 1);
  assert.deepEqual((await rowsOf(page)).map((row) => row.status), ['accepted', 'queued']);
  const recall = () => page.locator('[data-testid=outbox] li[data-status=queued]').getByRole('button', { name: '取回编辑' });
  // 草稿非空时禁用：取回是整体替换，不覆盖未保存输入。
  await type(page, '占用草稿');
  assert.equal(await recall().isDisabled(), true);
  await editorOf(page).fill('');
  await page.waitForFunction(() => window.composerTest.engine.getSnapshot().state.draft.snapshot.text === '');
  assert.equal(await recall().isEnabled(), true);
  // 取回：整条快照（含附件字节）回到草稿，行状态转 cancelled；在途的 A 不受影响。
  await recall().click();
  await page.waitForFunction(() => {
    const view = window.composerTest.engine.getSnapshot();
    return view.state.draft.snapshot.text === '第二条' && !view.dirty;
  });
  await waitStatus(page, 'cancelled', 1);
  assert.deepEqual((await rowsOf(page)).map((row) => row.status), ['accepted', 'cancelled']);
  // 结束轮次：只有 A 送达；被取回的 B 以 cancelled 终态留在本地，永不投递。
  await page.getByTestId('end-turn').click();
  await page.waitForFunction(async () => {
    const view = window.composerTest.engine.getSnapshot();
    const done = view.state.submissions[1]?.status === 'cancelled'
      && !view.state.activeTurn
      && !view.dirty;
    if (!done) return false;
    const stats = await (await fetch('api/stats')).json();
    return stats.messages.length === 1;
  });
  assert.deepEqual((await messages(page, scope)).map((message) => message.snapshot.text), ['A']);
});
