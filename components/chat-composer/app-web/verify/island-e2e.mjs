// Phase 1 挂载 PoC E2E（真实浏览器 + Dioxus WASM + Lexical Island JS，无 React）。
// 序列 = A+ 计划 §十八：Dioxus 页面启动 → 创建 Island → 中文输入 → Enter →
// Editor State → Rust 台账 → Outbox Accepted → 销毁重建。
// 前置（校机）：bash verify/build-e2e.sh（wasm 构建 + bindgen + vendor 拷贝到 dist）。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { startStaticServer, INDEX_HTML } from "./static-server.mjs";

const distRoot = new URL("./dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await mkdir(distRoot, { recursive: true });
await writeFile(distRoot + "index.html", INDEX_HTML);
for (const name of ["app_web.js", "app_web_bg.wasm", "island.js"]) {
  await writeFile(distRoot + name, await readFile(new URL(`../../vendor/${name}`, import.meta.url)));
}

const server = await startStaticServer(distRoot);
const browser = await chromium.launch({ channel: process.env.CE_BROWSER_CHANNEL || "msedge", headless: true });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on("pageerror", (error) => { errors.push(String(error)); console.log("[pageerror]", String(error).slice(0, 200)); });
page.on("console", (message) => { if (message.type() === "error") console.log("[console.error]", message.text().slice(0, 200)); });

const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: Boolean(cond), detail }); console.log(`${cond ? "✔" : "✖"} ${name}${cond ? "" : ` — ${detail}`}`); };
const eventsOf = (type) => page.evaluate((type) => (window.__islandEvents ?? []).filter((event) => event.type === type).length, type);

// 1. Dioxus 启动 + Island 挂载（onmounted eval → createController，唯一 root）
await page.goto(`${server.url}?editor=lexical`);
await page.waitForFunction(() => document.querySelector("[data-lexical-root]") !== null, { timeout: 30000 });
check("Dioxus 启动且 Island 挂载（唯一 root）", await page.evaluate(() => document.querySelectorAll("[data-lexical-root]").length) === 1);

// 2. 中文合成输入（B12 同款合成事件）→ 文本可见
await page.evaluate(() => {
  document.querySelector("[data-lexical-root]").focus();
  document.querySelector("[data-lexical-root]").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "你好" }));
});
await page.keyboard.insertText("你好 Bridge");
await page.evaluate(() => {
  document.querySelector("[data-lexical-root]").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
});
await page.waitForFunction(() => window.__islandController.getPlainText().includes("你好 Bridge"), { timeout: 10000 });
check("中文输入可见（合成 IME 路径）", true);

// 3. Enter → submit-request 事件 → Rust 台账 handoff
await page.evaluate(() => { window.__islandEvents = []; });
await page.keyboard.press("Enter");
await page.waitForFunction(() => (window.__islandEvents ?? []).some((event) => event.type === "submit-request"), { timeout: 10000 });
check("Enter 触发 submit-request", true);

// 4. Rust 台账：Outbox Accepted（do_submit 回环接纳）+ FM01 草稿清空
await page.waitForFunction(() => {
  const view = window.__composerView();
  return view?.state?.submissions?.[0]?.status === "accepted";
}, { timeout: 10000 });
const outboxText = await page.evaluate(() => window.__composerView().state.submissions[0].snapshot.text);
check("Outbox Accepted 且文本正确", outboxText === "你好 Bridge", outboxText);
check("交接后草稿清空（FM01）", await page.evaluate(() => window.__composerView().state.draft.snapshot.text) === "");

// 5. 销毁 + 重建（失效模式 1/2）
await page.evaluate(() => window.__islandController.destroy());
check("destroy 后容器归零（失效模式 2）", await page.evaluate(() => document.getElementById("lexical-island-container").children.length) === 0);
await page.evaluate(() => window.__islandRemount());
await page.waitForFunction(() => document.querySelector("[data-lexical-root]") !== null, { timeout: 10000 });
check("重新挂载可用", true);

// 6. 无未捕获错误
check("无未捕获页面错误", errors.length === 0, JSON.stringify(errors));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
