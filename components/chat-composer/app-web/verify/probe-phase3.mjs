// Phase 3 探针 v6：Enter 追踪——组合中的 Enter 到底进没进裁决器。
import { writeFile, mkdir, cp } from "node:fs/promises";
import { chromium } from "playwright-core";
import { startStaticServer, INDEX_HTML } from "./static-server.mjs";

const distRoot = new URL("./dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await mkdir(distRoot, { recursive: true });
await cp(new URL("../vendor/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), distRoot, { recursive: true });
await writeFile(distRoot + "index.html", INDEX_HTML);

const server = await startStaticServer(distRoot);
const browser = await chromium.launch({ channel: process.env.CE_BROWSER_CHANNEL || "msedge", headless: true });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on("pageerror", (error) => { errors.push(String(error).slice(0, 200)); });

await page.goto(`${server.url}?editor=lexical`);
await page.waitForFunction(() => document.querySelector("[data-lexical-root]") !== null, { timeout: 30000 });

const collapse = () => page.evaluate(() => {
  const sel = document.getSelection();
  if (sel && sel.rangeCount) { sel.collapseToEnd(); }
});

await page.evaluate(() => {
  const root = document.querySelector("[data-lexical-root]");
  root.focus();
  root.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "你好" }));
});
await page.keyboard.insertText("你好 Bridge");
await page.evaluate(() => {
  const root = document.querySelector("[data-lexical-root]");
  root.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
});
await collapse();

// __enterTrace 探针已随 Phase 7 清理移除（D009 实录：组合中 Lexical 不派发
// KEY_ENTER_COMMAND）；本探针保留合成组合 DOM 状态 dump 用途。
await page.evaluate(() => {
  const root = document.querySelector("[data-lexical-root]");
  root.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "测" }));
});
await page.keyboard.press("Enter");
await page.evaluate(() => {
  const root = document.querySelector("[data-lexical-root]");
  root.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "测" }));
});
await page.waitForTimeout(100);

const result = await page.evaluate(() => ({
  text: window.__islandController.getPlainText(),
  events: (window.__islandEvents ?? []).map((event) => event.type),
}));
console.log("V1 result:", JSON.stringify(result).slice(0, 600));
console.log("errors:", JSON.stringify(errors));
await browser.close();
server.close();
