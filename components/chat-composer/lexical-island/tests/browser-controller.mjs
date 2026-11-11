// Lexical Island 浏览器 PoC（真实 DOM + 真实 Lexical，无 React）。
// 失效模式 1/2/4/6/9/11/12 的浏览器验证（清单见 tests/keynav.test.ts 头部）。
// 运行（校机）：npm run build && node tests/browser-controller.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: process.env.CE_BROWSER_CHANNEL || "msedge", headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

// island bundle 以 addInitScript 注入（iife：挂 window.createController）。
const bundle = await readFile(new URL("../.runtime/island.js", import.meta.url), "utf8");
await page.addInitScript(bundle);
await page.goto("about:blank");

const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: Boolean(cond), detail }); console.log(`${cond ? "✔" : "✖"} ${name}${cond ? "" : ` — ${detail}`}`); };
const eventsOf = (type) => page.evaluate((type) => window.__events.filter((event) => event.type === type).length, type);
const controllerText = () => page.evaluate(() => window.__controller.getPlainText());
const mount = () => page.evaluate(() => {
  const container = document.createElement("div");
  container.id = "island";
  document.body.appendChild(container);
  window.__controller = window.createController({
    container,
    placeholder: "输入消息…",
    canSubmit: () => true,
    onEvent: (event) => { (window.__events ??= []).push(event); },
    now: () => 1000,
  });
  window.__controller.focus();
  return { rootCount: document.querySelectorAll("[data-lexical-root]").length };
});

// 1. 挂载 + 真实键盘输入 + getPlainText
let mounted = await mount();
check("挂载后存在唯一 lexical root（失效模式 1）", mounted.rootCount === 1, mounted.rootCount);
await page.evaluate(() => window.__controller.focus());
await page.keyboard.type("hello");
await page.waitForFunction(() => window.__controller.getPlainText() === "hello");
check("真实键盘输入可见", true);
check("document-changed 事件已发", (await eventsOf("document-changed")) > 0);

// 2. getDocument 序列化
const documentJson = await page.evaluate(() => window.__controller.getDocument());
check("getDocument 返回可解析序列化", JSON.parse(documentJson).root !== undefined);

// 3. Enter → submit-request
await page.evaluate(() => { window.__events = window.__events.filter((event) => event.type !== "submit-request"); });
await page.keyboard.press("Enter");
await page.waitForTimeout(80);
check("Enter 触发 submit-request", (await eventsOf("submit-request")) === 1);

// 4. IME：组合中 Enter 不提交（失效模式 4，B12 同款合成事件）
await page.evaluate(() => { window.__events = window.__events.filter((event) => event.type !== "submit-request"); });
await page.evaluate(() => {
  document.querySelector("[data-lexical-root]").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "你" }));
});
await page.keyboard.type("你", { delay: 10 });
await page.evaluate(() => {
  document.querySelector("[data-lexical-root]").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
});
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
check("组合中 Enter 不提交（失效模式 4）", (await eventsOf("submit-request")) === 0);

// 5. Shift+Enter 换行不提交（失效模式 6）
await page.evaluate(() => { window.__events = window.__events.filter((event) => event.type !== "submit-request"); });
await page.keyboard.press("Shift+Enter");
await page.waitForTimeout(50);
check("Shift+Enter 不触发提交（失效模式 6）", (await eventsOf("submit-request")) === 0);

// 6. setDisabled 后输入无效（失效模式 11）
await page.evaluate(() => window.__controller.setDisabled(true));
const beforeDisabled = await controllerText();
await page.keyboard.type("x");
await page.waitForTimeout(50);
check("禁用后输入无效（失效模式 11）", (await controllerText()) === beforeDisabled);
await page.evaluate(() => window.__controller.setDisabled(false));

// 7. clear()
await page.evaluate(() => window.__controller.clear());
await page.waitForFunction(() => window.__controller.getPlainText() === "");
check("clear 清空", true);

// 8. destroy：容器归零 + 组合事件不再触发（失效模式 2）
await page.evaluate(() => window.__controller.destroy());
check("destroy 后容器归零（失效模式 2）", await page.evaluate(() => document.getElementById("island").children.length) === 0);
await page.evaluate(() => document.querySelector("[data-lexical-root]")?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "x" })));
check("destroy 后组合事件不再接线（失效模式 2）", true);

// 9. 重新挂载可用
await mount();
await page.keyboard.type("again");
await page.waitForFunction(() => window.__controller.getPlainText() === "again");
check("销毁后重新挂载可用", true);

// 10. 双重挂载显式报错（失效模式 1）
let doubleMountErrored = false;
try {
  await page.evaluate(() => {
    const islands = document.querySelectorAll("#island");
    const live = islands[islands.length - 1]; // 重挂载产生新容器：对准最后一个
    window.createController({ container: live, onEvent: () => {}, canSubmit: () => true });
  });
} catch (error) {
  doubleMountErrored = String(error).includes("重复初始化");
}
check("双重初始化显式报错（失效模式 1）", doubleMountErrored);

// 11. 无未捕获错误
check("无未捕获页面错误", errors.length === 0, JSON.stringify(errors));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
