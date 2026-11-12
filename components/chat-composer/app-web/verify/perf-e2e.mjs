// E2 性能基线 v2：taino vs island 双模式对测（D013「性能合格」项）。
// 每个指标独立加载新页面（避免跨编辑器的清空路径差异）；CDP 墙钟含固定
// CDP 开销——两模式同 overhead，差值即应用成本差。
import { chromium } from 'playwright-core';
import { startStaticServer, INDEX_HTML } from './static-server.mjs';
import { writeFile, mkdir, cp } from 'node:fs/promises';

const distRoot = new URL('./dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await mkdir(distRoot, { recursive: true });
await cp(new URL("../vendor/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), distRoot, { recursive: true });
await writeFile(distRoot + "index.html", INDEX_HTML);

const server = await startStaticServer(distRoot);
const browser = await chromium.launch({ channel: process.env.CE_BROWSER_CHANNEL || 'msedge', headless: true });
const context = await browser.newContext();
const errors = [];

async function freshPage(mode) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`[${mode}] ` + String(e).slice(0, 150)));
  await page.goto(`${server.url}?editor=${mode}`);
  await page.waitForSelector('[contenteditable="true"]', { timeout: 30000 });
  await page.waitForFunction(() => window.__composerView !== undefined, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('[contenteditable="true"]').focus());
  return page;
}

async function measure(mode) {
  const rows = {};
  const chunk = 'hello world '.repeat(100); // 1200 chars
  const keys = 'the quick brown fox jumps over the lazy dog. '.repeat(3).slice(0, 138);
  const big = 'x'.repeat(50000);

  // 1. 一次性插入 1200 字符
  let page = await freshPage(mode);
  let t0 = Date.now();
  await page.keyboard.insertText(chunk);
  await page.waitForFunction((n) => window.__composerView()?.state?.draft?.snapshot?.text?.length >= n, chunk.length, { timeout: 20000 });
  rows.oneShotMs = Date.now() - t0;
  await page.close();

  // 2. 逐键 138 字符（CDP 每键 ~1-2ms 打底）
  page = await freshPage(mode);
  t0 = Date.now();
  await page.keyboard.type(keys, { delay: 0 });
  await page.waitForFunction((n) => window.__composerView()?.state?.draft?.snapshot?.text?.length >= n, keys.length, { timeout: 30000 });
  rows.perKeyMs = Date.now() - t0;
  await page.close();

  // 3. 提交周期（打几个字 → Enter → Accepted）
  page = await freshPage(mode);
  await page.keyboard.insertText('perf submit');
  await page.waitForFunction(() => window.__composerView()?.state?.draft?.snapshot?.text?.length > 0, undefined, { timeout: 10000 });
  t0 = Date.now();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[0]?.status === 'accepted', undefined, { timeout: 15000 });
  rows.submitMs = Date.now() - t0;
  await page.close();

  // 4. 长文档 50k
  page = await freshPage(mode);
  t0 = Date.now();
  await page.keyboard.insertText(big);
  await page.waitForFunction((n) => window.__composerView()?.state?.draft?.snapshot?.text?.length >= n, big.length, { timeout: 60000 });
  rows.longDocMs = Date.now() - t0;
  await page.close();

  return rows;
}

const out = {};
for (const mode of ['taino', 'lexical']) {
  try {
    out[mode] = await measure(mode);
  } catch (e) {
    out[mode] = { error: String(e).slice(0, 120) };
  }
}
console.log('PERF RESULTS:');
console.log(JSON.stringify(out, null, 1));
if (out.taino.oneShotMs && out.lexical.oneShotMs) {
  console.log(`one-shot 1200: taino ${out.taino.oneShotMs}ms vs island ${out.lexical.oneShotMs}ms`);
  console.log(`per-keystroke 138: taino ${out.taino.perKeyMs}ms vs island ${out.lexical.perKeyMs}ms`);
  console.log(`submit: taino ${out.taino.submitMs}ms vs island ${out.lexical.submitMs}ms`);
  console.log(`longDoc 50k: taino ${out.taino.longDocMs}ms vs island ${out.lexical.longDocMs}ms`);
}
if (errors.length) console.log('pageerrors:', JSON.stringify(errors.slice(0, 5)));
await browser.close();
server.close();
