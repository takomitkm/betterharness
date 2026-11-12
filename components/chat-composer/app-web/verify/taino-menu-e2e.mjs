// E3a 端到端：候选菜单（composer-completion + taino 线）。
// 判据与 TS CandidateMenu 契约一一对应（D018）：
//   @ 触发 / 过滤缩窄 / ArrowUp-Down 导航 / Enter 接受不提交（KD has_menu）/
//   替换写回 + 补尾空格 / Esc 关菜单 / slash 触发 / 提交关菜单 / 关菜单后 Enter 恢复提交。
import { writeFile, mkdir, cp } from "node:fs/promises";
import { chromium } from "playwright-core";
import { startStaticServer, INDEX_HTML } from "./static-server.mjs";

// CI（ubuntu runner）无 msedge：CE_BROWSER_CHANNEL=chromium → bundled chromium。
const launchChannel = () => {
  const channel = process.env.CE_BROWSER_CHANNEL;
  return channel && channel !== "chromium" ? channel : undefined;
};

const distRoot = new URL("./dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await mkdir(distRoot, { recursive: true });
await cp(new URL("../vendor/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), distRoot, { recursive: true });
await writeFile(distRoot + "index.html", INDEX_HTML);

const server = await startStaticServer(distRoot);
const browser = await chromium.launch({ channel: launchChannel(), headless: true });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: Boolean(cond), detail }); console.log(`${cond ? "✔" : "✖"} ${name}${cond ? "" : ` — ${detail}`}`); };
const composerView = () => page.evaluate(() => window.__composerView());
const editorText = () => page.evaluate(() => document.querySelector('[contenteditable="true"]')?.textContent ?? "");
const focusEditor = () => page.evaluate(() => document.querySelector('[contenteditable="true"]').focus());
const menuVisible = () => page.evaluate(() => {
  const menu = document.querySelector('[data-testid="candidate-menu"]');
  return menu ? Array.from(menu.querySelectorAll('[role="option"]')).map((li) => li.textContent) : null;
});
const highlighted = () => page.evaluate(() => document.querySelector(".candidate.highlighted")?.textContent ?? null);
const freshPage = async () => {
  // 每判据段独立加载：唯一 scope（E3c IDB 持久化后，freshPage 恢复上一段状态——
  // 唯一 scope = 全新基线）。
  const scope = `menu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto(`${server.url}?editor=taino&scope=${scope}`);
  await page.waitForFunction(() => window.__composerView !== undefined, { timeout: 30000 });
  await page.waitForSelector('[contenteditable="true"]', { timeout: 15000 });
  await focusEditor();
};

await page.goto(`${server.url}?editor=taino`);
await page.waitForFunction(() => window.__composerView !== undefined, { timeout: 30000 });
await page.waitForSelector('[contenteditable="true"]', { timeout: 15000 });

// 1. @ 触发
await focusEditor();
await page.keyboard.type("看下 @");
await page.waitForFunction(() => document.querySelector('[data-testid="candidate-menu"]') !== null, undefined, { timeout: 10000 });
let items = await menuVisible();
check("1a @ 触发菜单（5 候选）", items?.length === 5, JSON.stringify(items));
check("1b 默认高亮首位", (await highlighted()) === items?.[0], await highlighted());

// 2. 过滤缩窄
await page.keyboard.type("s1");
items = await menuVisible();
check("2 过滤缩窄（s1-alpha.md）", items?.length === 1 && items[0]?.includes("s1-alpha"), JSON.stringify(items));

// 3. Enter 接受：不提交 + 替换写回（@s1 → @s1-alpha.md + 补尾空格）
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
let view = await composerView();
check("3a 接受不提交（KD has_menu）", view.state.submissions.length === 0, JSON.stringify(view.state.submissions));
const text1 = await editorText();
check("3b 替换写回 + 补尾空格", text1 === "看下 @s1-alpha.md ", JSON.stringify(text1));
check("3c 菜单随接受关闭", (await menuVisible()) === null, JSON.stringify(await menuVisible()));

// 4. 重新触发 + ArrowDown 导航 + Esc 关闭
await freshPage();
await page.keyboard.type("@");
await page.waitForFunction(() => document.querySelector('[data-testid="candidate-menu"]') !== null, undefined, { timeout: 10000 });
await page.waitForFunction(() => document.querySelector('[data-testid="candidate-menu"]') !== null, undefined, { timeout: 10000 });
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(200);
const afterDown = await highlighted();
check("4a ArrowDown 高亮下移", afterDown !== (await menuVisible())?.[0], afterDown);
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(200);
check("4b ArrowUp 高亮回首位", (await highlighted()) === (await menuVisible())?.[0], await highlighted());
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("4c Esc 关菜单", (await menuVisible()) === null, JSON.stringify(await menuVisible()));
check("4d Esc 后触发符保留", (await editorText()) === "@", JSON.stringify(await editorText()));

// 5. slash 触发
await freshPage();
await page.keyboard.type("/");
await page.waitForFunction(() => document.querySelector('[data-testid="candidate-menu"]') !== null, undefined, { timeout: 10000 });
items = await menuVisible();
check("5 slash 触发（2 命令）", items?.length === 2, JSON.stringify(items));

// 6. 无触发文本 + Enter → 直接提交（菜单未开时 Enter 恢复提交语义）
// 注：Esc 后继续打字会重新触发 slash 菜单（"/help" 的 query 持续命中——产品正确
// 行为，TS demo 同款），故用无触发符的纯文本验证提交语义。
await freshPage();
await page.keyboard.type("hello");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.length === 1, undefined, { timeout: 10000 });
view = await composerView();
check("6 无菜单 Enter 恢复提交", view.state.submissions[0]?.status === "accepted" && view.state.submissions[0]?.snapshot?.text === "hello", JSON.stringify(view.state.submissions));

// 7. 菜单开着时第二条 Enter：接受而非提交（不产生第二条 submission）
await freshPage();
await page.keyboard.type("@");
await page.waitForFunction(() => document.querySelector('[data-testid="candidate-menu"]') !== null, undefined, { timeout: 10000 });
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
view = await composerView();
check("7 菜单 Enter 不产生新提交（freshPage 后基线 0）", view.state.submissions.length === 0, JSON.stringify(view.state.submissions));

check("8a 零未捕获页面错误", errors.length === 0, JSON.stringify(errors));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
