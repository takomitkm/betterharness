// demo.html 的 Playwright 断言脚本（可 clone 复现 README「验证记录」里的浏览器数字）。
//
// 运行：cd components/chat-composer/verify && node demo-playwright.mjs
// 依赖：playwright-core（npm i playwright-core，或用 CE_PLAYWRIGHT_PATH 指向已有安装）；
//       浏览器通道默认 msedge，可用 CE_BROWSER_CHANNEL=chrome 等覆盖。
// 流程：读取仓库内 ../demo.html（Gen-UI 片段），包一层完整 HTML 写入系统临时目录，
//       用 file:// 打开后跑断言；不往仓库写任何文件。
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const demoPath = new URL('../demo.html', import.meta.url);

// —— playwright-core 解析：环境变量 → 就近 require → 校机已知路径 ——
function loadPlaywright() {
  const candidates = [];
  if (process.env.CE_PLAYWRIGHT_PATH) candidates.push(process.env.CE_PLAYWRIGHT_PATH);
  try {
    return { chromium: createRequire(import.meta.url)('playwright-core').chromium };
  } catch { /* fallthrough */ }
  candidates.push('D:/yzd/zcode-e2e/ZCode/node_modules/playwright-core');
  for (const c of candidates) {
    try {
      return { chromium: createRequire(import.meta.url)(c).chromium };
    } catch { /* try next */ }
  }
  console.error('playwright-core 未找到：npm i playwright-core，或设 CE_PLAYWRIGHT_PATH=<路径>/playwright-core');
  process.exit(2);
}

const { chromium } = loadPlaywright();
const channel = process.env.CE_BROWSER_CHANNEL || 'msedge';

// —— 片段包壳 ——
const fragment = readFileSync(demoPath, 'utf8');
const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
body{background:#fff;color:#111;font:14px system-ui;padding:16px}
#ce-lab{display:flex;flex-direction:column;gap:10px;max-width:720px}
button{padding:4px 8px}textarea{width:100%;min-height:76px;font-family:monospace}
#ce-log{max-height:220px;overflow:auto;padding-left:1.4em}
</style></head><body>${fragment}</body></html>`;
const outFile = join(tmpdir(), 'betterharness-ce-standalone.html');
writeFileSync(outFile, pageHtml, 'utf8');

const results = [];
const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });

const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => results.push({ name: 'PAGEERROR', pass: false, detail: String(e) }));
await page.goto(pathToFileURL(outFile).href);

const readText = () => page.textContent('#ce-text');
const readCounts = () => page.textContent('#ce-counts');
const readLog = () => page.textContent('#ce-log');
const readPhase = () => page.textContent('#ce-phase');
const setRange = (id, v) => page.evaluate(({ id, v }) => {
  const el = document.getElementById(id);
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, { id, v });
const pickMode = (m) => page.click('[data-mode="' + m + '"]');
const resetCase = () => page.click('#ce-reset');

await setRange('ce-accept', 300);
await setRange('ce-gen', 900);

// A. 在途窗口内双击（四家差异点）
const dblExpect = [
  ['zcode-fix', '""'],
  ['zcode-3172', '"A\\n"'],
  ['codex', '""'],
  ['cc', '""'],
];
let fixLog = '';
let legacyLog = '';
for (const pair of dblExpect) {
  const mode = pair[0];
  const expect = pair[1];
  await pickMode(mode);
  await resetCase();
  await page.fill('#ce-editor', 'A');
  await page.click('#ce-dbl');
  await page.waitForTimeout(1500);
  check(mode + ': 双击后编辑器', (await readText()) === expect, await readText());
  check(mode + ': 只发 1 条', (await readCounts()).startsWith('1 /'), await readCounts());
  if (mode === 'zcode-fix') fixLog = await readLog();
  if (mode === 'zcode-3172') legacyLog = await readLog();
}
check('3172: 日志点名 BUG', legacyLog.includes('残留'), '');
check('fix: 在途 no-op 文案', fixLog.includes('no-op'), '');

// A2. DSH：在途锁编辑器（只读 + 保留草稿），Host 受理后才清空
await pickMode('dsh');
await resetCase();
await page.fill('#ce-editor', 'A');
await page.click('#ce-dbl');
await page.waitForTimeout(90);
check('dsh: 在途编辑器只读', await page.$eval('#ce-editor', (el) => el.readOnly === true), '');
check('dsh: 在途保留草稿（不清空）', (await readText()) === '"A"', await readText());
await page.waitForTimeout(1600);
check('dsh: Host 受理后清空', (await readText()) === '""', await readText());
check('dsh: 只发 1 条', (await readCounts()).startsWith('1 /'), await readCounts());
check('dsh: 日志点名只读锁', (await readLog()).includes('只读'), '');

// A3. DSH 生成中按 Enter → 排队
await pickMode('dsh');
await resetCase();
await page.fill('#ce-editor', 'A');
await page.click('#ce-send');
await page.waitForTimeout(500);
check('dsh: 已进入生成中', (await readPhase()).includes('模型生成中'), await readPhase());
await page.fill('#ce-editor', 'B');
await page.click('#ce-send');
check('dsh: 生成中排队 → 队列 1', (await readCounts()).endsWith('/ 1'), await readCounts());
await page.waitForTimeout(2800);
check('dsh: 队列轮末发出', (await readCounts()).startsWith('2'), await readCounts());

// B. 模型生成中按 Enter：ZCode 两版都应排队
for (const mode of ['zcode-fix', 'zcode-3172']) {
  await pickMode(mode);
  await resetCase();
  await page.fill('#ce-editor', 'A');
  await page.click('#ce-send');
  await page.waitForTimeout(420);
  check(mode + ': 已进入生成中', (await readPhase()).includes('模型生成中'), await readPhase());
  await page.fill('#ce-editor', 'B');
  await page.click('#ce-send');
  check(mode + ': 生成中排队 → 队列 1', (await readCounts()).endsWith('/ 1'), await readCounts());
  check(mode + ': 排队后框清空', (await readText()) === '""', await readText());
  check(mode + ': 日志显示排队', (await readLog()).includes('排队'), '');
  await page.waitForTimeout(2800);
  check(mode + ': 队列在轮末自动发出', (await readCounts()).startsWith('2'), await readCounts());
}

// C. Codex / CC 生成中
await pickMode('codex');
await resetCase();
await page.fill('#ce-editor', 'A');
await page.click('#ce-send');
await page.waitForTimeout(420);
await page.fill('#ce-editor', 'B');
await page.click('#ce-send');
check('codex: 生成中 → steer', (await readLog()).includes('steer'), '');
await page.waitForTimeout(1700);

await pickMode('cc');
await resetCase();
await page.fill('#ce-editor', 'A');
await page.click('#ce-send');
await page.waitForTimeout(420);
await page.fill('#ce-editor', 'B');
await page.click('#ce-send');
check('cc: 生成中 → 入队', (await readLog()).includes('queuedCommands'), '');
await page.focus('#ce-editor');
await page.keyboard.press('ArrowUp');
check('cc: ↑ 取回', (await readText()) === '"B"', await readText());
await page.waitForTimeout(1700);

// D. 失败恢复
await pickMode('zcode-fix');
await resetCase();
await page.check('#ce-fail');
await page.fill('#ce-editor', 'X');
await page.click('#ce-send');
await page.waitForTimeout(1700);
check('fix: 失败恢复原文', (await readText()) === '"X"', await readText());

// E. 失败 + 新草稿不被覆盖
await pickMode('zcode-fix');
await resetCase();
await page.check('#ce-fail');
await page.fill('#ce-editor', 'A');
await page.click('#ce-send');
await page.waitForTimeout(420);
await page.fill('#ce-editor', 'B-new');
await page.waitForTimeout(1700);
check('fix: 新草稿保留', (await readText()) === '"B-new"', await readText());
check('fix: A 记为失败项', (await readCounts()).includes('/ 1 /'), await readCounts());

// F. Shift+Enter 显式换行
await pickMode('zcode-fix');
await resetCase();
await page.fill('#ce-editor', 'L1');
await page.keyboard.press('Shift+Enter');
await page.keyboard.type('L2');
check('fix: Shift+Enter 换行', (await readText()) === '"L1\\nL2"', await readText());

await browser.close();
try { rmSync(outFile); } catch { /* 临时文件清理失败不影响结果 */ }
const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length === 0 ? 0 : 1);
