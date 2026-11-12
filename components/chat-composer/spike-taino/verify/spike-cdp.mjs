// E0 判据测试：taino-edit + composer-keynav 的 composer 形态冒烟。
// 判据：Enter 仲裁（真实键盘）→ accepted + 清空（FM01）；失效模式 4（组合中
// Enter 不提交）；KD03 宽限窗（compositionend 后 10ms 内 Enter 不提交）。
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = 'D:/yzd/spike-taino-composer';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    const file = p === '/' ? 'index.html' : p.slice(1);
    const data = await readFile(join(ROOT, file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'text/plain' });
    res.end(data);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('nf'); }
});
await new Promise((r) => server.listen(8791, '127.0.0.1', r));

const browser = await chromium.launch({ channel: process.env.CE_BROWSER_CHANNEL || 'msedge', headless: true });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push('[console] ' + m.text().slice(0, 200)); });

const results = [];
const check = (name, cond, detail) => { results.push(Boolean(cond)); console.log(`${cond ? '✔' : '✖'} ${name}${cond ? '' : ` — ${detail}`}`); };
const state = () => page.evaluate(() => JSON.parse(window.spike_state()));
const editorText = () => page.evaluate(() => document.querySelector('[contenteditable="true"]')?.textContent ?? null);
const focusEditor = () => page.evaluate(() => document.querySelector('[contenteditable="true"]').focus());

await page.goto('http://127.0.0.1:8791/');
await page.waitForFunction(() => window.__booted === true, { timeout: 30000 }).catch(() => console.log('BOOT TIMEOUT'));
await page.waitForSelector('[contenteditable="true"]', { timeout: 15000 }).catch(async () => {
  const dump = await page.evaluate(() => ({
    booted: window.__booted ?? null,
    body: document.body.innerHTML.slice(0, 400),
  }));
  console.log('MOUNT FAIL dump:', JSON.stringify(dump));
});
check('挂载：contenteditable 存在', await page.evaluate(() => document.querySelector('[contenteditable="true"]') !== null));

// 1. 真实键盘输入 + Enter → accepted + 清空（FM01）
await focusEditor();
await page.keyboard.type('hello taino 中文');
check('1a 键盘输入可见', (await editorText())?.includes('hello taino 中文'), await editorText());
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
let s = await state();
check('1b Enter → accepted（仲裁接线）', s.length === 1 && s[0].status === 'accepted', JSON.stringify(s));
check('1c 文本正确', s[0]?.text === 'hello taino 中文', s[0]?.text);
check('1d FM01 编辑器清空', (await editorText()) === '', JSON.stringify(await editorText()));

// 2. 失效模式 4：合成组合中 Enter 不提交
await focusEditor();
await page.evaluate(() => {
  const el = document.querySelector('[contenteditable="true"]');
  el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '测' }));
});
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
s = await state();
check('2 组合中 Enter 不提交（失效模式 4）', s.length === 1, JSON.stringify(s));
await page.evaluate(() => {
  const el = document.querySelector('[contenteditable="true"]');
  el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '测' }));
});

// 3. KD03 宽限窗：compositionend 后同一 JS 任务内立即合成 keydown Enter → 不提交
await page.evaluate(() => {
  const el = document.querySelector('[contenteditable="true"]');
  el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '测' }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
});
await page.waitForTimeout(300);
s = await state();
check('3 KD03 宽限窗内 Enter 不提交', s.length === 1, JSON.stringify(s));

// 4. 宽限窗外真实 Enter → 新提交（证明仲裁没有全吞）
await page.waitForTimeout(80); // > 10ms 宽限窗
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
s = await state();
check('4 宽限窗外 Enter 正常提交', s.length === 2, JSON.stringify(s));

// favicon 404 是测试服务器路由缺席，非产品错误（island E2E 同款处理）
const product_errors = errors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
check('5 零未捕获页面错误', product_errors.length === 0, JSON.stringify(product_errors));

const failed = results.filter((v) => !v).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
