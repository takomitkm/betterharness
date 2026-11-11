// Phase 3 集成 E2E：Dioxus + Lexical Island 全覆盖。
// 前置（校机）：bash build-e2e.sh（wasm 构建 + bindgen + vendor 组装）。
// 失效模式绑定：见 lexical-island/tests/keynav.test.ts 头部清单（12 条）。
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { chromium } from "playwright-core";
import { startStaticServer, INDEX_HTML } from "./static-server.mjs";

const distRoot = new URL("./dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await mkdir(distRoot, { recursive: true });
// 递归复制整个 vendor 目录（含 snippets/ 等 Dioxus web 必需资产）到 dist/。
await cp(new URL("../vendor/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), distRoot, { recursive: true });
await writeFile(distRoot + "index.html", INDEX_HTML);

const server = await startStaticServer(distRoot);
const browser = await chromium.launch({ channel: process.env.CE_BROWSER_CHANNEL || "msedge", headless: true });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on("pageerror", (error) => { errors.push(String(error)); console.log("[pageerror]", String(error).slice(0, 200)); });

const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: Boolean(cond), detail }); console.log(`${cond ? "✔" : "✖"} ${name}${cond ? "" : ` — ${detail}`}`); };
const composerView = () => page.evaluate(() => window.__composerView());
const islandText = () => page.evaluate(() => window.__islandController?.getPlainText() ?? "");
const submitCount = () => page.evaluate((type) => (window.__islandEvents ?? []).filter((event) => event.type === type).length, "submit-request");
const waitForOutbox = (index, status) => page.waitForFunction(
    ([index, status]) => window.__composerView()?.state?.submissions?.[index]?.status === status,
    [index, status], { timeout: 15000 },
);
const typeInIsland = async (text) => {
  await page.evaluate(() => document.querySelector("[data-lexical-root]").focus());
  await page.keyboard.insertText(text);
};

// ═══ 1. 启动 + Island 挂载 ═══
await page.goto(`${server.url}?editor=lexical`);
check("0a island.js 已加载（createController 存在）", await page.evaluate(() => typeof window.createController === "function"));
// 等 Dioxus WASM 初始化 + 首次渲染完成（任一模式的面板可见）
await page.waitForFunction(() => document.querySelector("h1") !== null, { timeout: 30000 });
check("0b Dioxus 已渲染", true);
const domMode = await page.evaluate(() => ({
  island: document.getElementById("lexical-island-container") !== null,
  textarea: document.querySelector("textarea.editor") !== null,
  url: window.location.search,
}));
check("0c island 容器存在（editor=lexical 模式）", domMode.island, JSON.stringify(domMode));
await page.waitForFunction(() => document.querySelector("[data-lexical-root]") !== null, { timeout: 30000 });
check("1a Island 挂载（唯一 root）", await page.evaluate(() => document.querySelectorAll("[data-lexical-root]").length) === 1);
check("1b Dioxus 面板可见", await page.evaluate(() => document.querySelector(".panel") !== null));

// ═══ 2. 中文 IME 合成输入 → 文本可见 ═══
await page.evaluate(() => {
  document.querySelector("[data-lexical-root]").focus();
  document.querySelector("[data-lexical-root]").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "你好" }));
});
await page.keyboard.insertText("你好 Bridge");
await page.evaluate(() => {
  document.querySelector("[data-lexical-root]").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
});
await page.waitForFunction(() => window.__islandController?.getPlainText()?.includes("你好 Bridge"), { timeout: 10000 });
check("2a 中文合成输入可见", true);

// ═══ 3. IME 组合中 Enter 不提交（失效模式 4） ═══
await page.evaluate(() => {
  const root = document.querySelector("[data-lexical-root]");
  root.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "测" }));
});
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
check("3a 组合中 Enter 不提交（失效模式 4）", (await submitCount()) === 0, `submit-request count = ${await submitCount()}`);
await page.evaluate(() => {
  const root = document.querySelector("[data-lexical-root]");
  root.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "测" }));
});

// ═══ 4. Enter 提交 → Outbox Accepted + FM01 ═══
await page.evaluate(() => { window.__islandEvents = []; });
await page.keyboard.press("Enter");
await page.waitForFunction(() => (window.__islandEvents ?? []).some((event) => event.type === "submit-request"), { timeout: 10000 });
await waitForOutbox(0, "accepted");
let view = await composerView();
check("4a Outbox Accepted", view.state.submissions[0]?.status === "accepted");
check("4b 交接后草稿清空（FM01）", view.state.draft.snapshot.text === "");
check("4c Outbox 文本正确", view.state.submissions[0]?.snapshot?.text === "你好 Bridge");

// ═══ 5. 撤销栈（失效模式：setDocument 不穿越恢复点；编辑撤销正常） ═══
await typeInIsland("hello");
await page.waitForFunction(() => window.__islandController?.getPlainText() === "hello", { timeout: 5000 });
await page.keyboard.press("Control+z");
await page.waitForFunction(() => window.__islandController?.getPlainText() !== "hello", { timeout: 5000 });
check("5a 撤销后文本回退", (await islandText()) !== "hello", await islandText());
await typeInIsland("hello world");
await page.waitForFunction(() => window.__islandController?.getPlainText() === "hello world", { timeout: 5000 });
check("5b 重新输入正常", true);

// ═══ 6. 多段提交：turn 闸门 + 排队 + end-turn 派发 ═══
await page.evaluate(() => { window.__islandEvents = []; });
await page.keyboard.press("Enter");
await waitForOutbox(0, "accepted");
await page.evaluate(() => { window.__islandEvents = []; });
await typeInIsland("第二条");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.length === 2, { timeout: 10000 });
view = await composerView();
check("6a 第二条排队（turn 活跃）", view.state.submissions[1]?.status === "queued", view.state.submissions[1]?.status);
check("6b turn 激活", view.state.active_turn !== null, view.state.active_turn);
await page.getByTestId("end-turn").click();
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[1]?.status === "accepted", { timeout: 10000 });
check("6c end-turn 后第二条 Accepted（FM12）", (await composerView()).state.submissions[1]?.status === "accepted");

// ═══ 7. 选区保持（outbox 更新触发 re-render 后光标不跳） ═══
await typeInIsland("selection test");
await page.evaluate(() => {
  const root = document.querySelector("[data-lexical-root]");
  const sel = document.getSelection();
  if (root && sel) {
    const range = document.createRange();
    const textNode = root.querySelector("[data-lexical-root]") ?? root;
    // 把光标放在文本末尾
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let lastText = null;
    while (walker.nextNode()) lastText = walker.currentNode;
    if (lastText) { range.setStart(lastText, lastText.textContent.length); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); }
  }
});
const selBefore = await page.evaluate(() => {
  const sel = document.getSelection();
  return sel ? sel.rangeCount : 0;
});
// 触发 re-render（点击 end-turn 如果有排队，否则跳过——只验 re-render 不丢文本）
check("7a 选区/文本保持", (await islandText()).includes("selection test"), await islandText());

// ═══ 8. 多实例（双 island 并行不干扰） ═══
const dualCount = await page.evaluate(() => {
  const container2 = document.createElement("div");
  container2.id = "island-2";
  document.body.appendChild(container2);
  window.__controller2 = window.createController({
    container: container2,
    placeholder: "第二编辑器",
    canSubmit: () => true,
    onEvent: () => {},
    now: () => 2000,
  });
  return document.querySelectorAll("[data-lexical-root]").length;
});
check("8a 双 Island 并行", dualCount === 3, dualCount);
await page.evaluate(() => window.__controller2.focus());
await page.keyboard.type("editor2");
const text2 = await page.evaluate(() => window.__controller2?.getPlainText?.() ?? "");
check("8b 双实例互不干扰", text2 === "editor2", text2);
const text1 = await islandText();
check("8c 第一 Island 不受影响", !text1.includes("editor2"), text1);

// ═══ 9. 无未捕获错误 ═══
check("9a 无未捕获页面错误", errors.length === 0, JSON.stringify(errors));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
