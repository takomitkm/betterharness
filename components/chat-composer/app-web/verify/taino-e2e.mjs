// E1 端到端：Dioxus + taino-edit（Pure Rust Editor）全覆盖。
// 前置（校机）：bash build-e2e.sh（wasm 构建 + bindgen 0.2.130 + vendor 组装）。
// 与 island-e2e.mjs 的差异：编辑器换 taino（无 island.js 事件桥——Enter 走 Rust
// 内部协程，断言直读台账）；双实例检查移除（单编辑器应用，taino 隔离 = 每组件
// 独立 EditorState）。语义判据与 island 24/24 一一对应（D013 对拍清单）。
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
const editorText = () => page.evaluate(() => document.querySelector('[contenteditable="true"]')?.textContent ?? null);
const focusEditor = () => page.evaluate(() => document.querySelector('[contenteditable="true"]').focus());
const typeInEditor = async (text) => { await focusEditor(); await page.keyboard.type(text); };
const waitForOutbox = (index, status) => page.waitForFunction(
    ([index, status]) => window.__composerView()?.state?.submissions?.[index]?.status === status,
    [index, status], { timeout: 15000 },
);

// ═══ 1. 启动 + taino 挂载 ═══
await page.goto(`${server.url}?editor=taino`);
await page.waitForFunction(() => window.__composerView !== undefined, { timeout: 30000 });
await page.waitForSelector('[contenteditable="true"]', { timeout: 15000 });
check("0 taino 编辑器挂载（contenteditable 唯一）",
    await page.evaluate(() => document.querySelectorAll('[contenteditable="true"]').length) === 1);
check("0b Dioxus 面板可见", await page.evaluate(() => document.querySelector(".panel") !== null));

// ═══ 2. 中文合成输入 → 文本可见（taino IME 管线，合成事件流同 B12）═══
await focusEditor();
await page.evaluate(() => {
  const el = document.querySelector('[contenteditable="true"]');
  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "你好" }));
});
await page.keyboard.type("hello taino 中文");
await page.evaluate(() => {
  const el = document.querySelector('[contenteditable="true"]');
  el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
});
await page.waitForTimeout(300);
check("2a 中文合成输入可见（内容零损坏）", (await editorText())?.includes("hello taino 中文"), await editorText());

// ═══ 3. 组合中 Enter 不提交（失效模式 4）+ KD03 宽限窗 ═══
await page.evaluate(() => {
  const el = document.querySelector('[contenteditable="true"]');
  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "测" }));
});
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
let view = await composerView();
check("3a 组合中 Enter 不提交（失效模式 4）", view.state.submissions.length === 0, JSON.stringify(view.state.submissions));
await page.evaluate(() => {
  const el = document.querySelector('[contenteditable="true"]');
  el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "测" }));
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
});
await page.waitForTimeout(300);
view = await composerView();
check("3b KD03 宽限窗内 Enter 不提交", view.state.submissions.length === 0, JSON.stringify(view.state.submissions));
await page.waitForTimeout(60);

// ═══ 4. Enter 提交 → Outbox Accepted + FM01（宽限窗外）═══
await page.evaluate(() => document.querySelector('[contenteditable="true"]').focus());
await page.keyboard.press("Enter");
await waitForOutbox(0, "accepted");
view = await composerView();
check("4a Outbox Accepted", view.state.submissions[0]?.status === "accepted");
check("4b FM01 草稿清空", view.state.draft.snapshot.text === "", view.state.draft.snapshot.text);
check("4c Outbox 文本正确", view.state.submissions[0]?.snapshot?.text?.includes("hello taino 中文"), view.state.submissions[0]?.snapshot?.text);
check("4d 编辑器随交接清空", (await editorText()) === "", await editorText());

// ═══ 5. 撤销栈（taino History：Mod-z；输入中途撤销不回穿越提交边界）═══
await typeInEditor("hello");
await page.waitForTimeout(200);
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
check("5a 撤销后文本回退", !(await editorText())?.includes("hello"), await editorText());
await typeInEditor("hello world");
await page.waitForTimeout(200);
check("5b 重新输入正常", (await editorText())?.includes("hello world"), await editorText());

// ═══ 6. 多段提交：turn 闸门 + 排队 + end-turn FIFO 派发 ═══
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.length === 2, undefined, { timeout: 10000 });
view = await composerView();
check("6a turn 活跃期间第二条入队", view.state.submissions[1]?.status === "queued", view.state.submissions[1]?.status);
check("6b turn 激活", view.state.active_turn !== null, view.state.active_turn);
await typeInEditor("第三条");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.length === 3, undefined, { timeout: 10000 });
view = await composerView();
check("6c 第三条继续排队（FIFO 尾部）", view.state.submissions[2]?.status === "queued", view.state.submissions[2]?.status);
await page.getByTestId("end-turn").click();
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[1]?.status === "accepted", undefined, { timeout: 10000 });
check("6d end-turn 派发队首（FM12 FIFO）", (await composerView()).state.submissions[1]?.status === "accepted");
await page.getByTestId("end-turn").click();
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[2]?.status === "accepted", undefined, { timeout: 10000 });
check("6e 第二次 end-turn 派发队尾", (await composerView()).state.submissions[2]?.status === "accepted");

// ═══ 7. 选区保持（outbox 更新触发 re-render 后文本不丢）═══
await typeInEditor("selection test");
await page.waitForTimeout(200);
check("7a re-render 后文本保持", (await editorText())?.includes("selection test"), await editorText());

// ═══ 8. 无未捕获错误 ═══
check("8a 零未捕获页面错误", errors.length === 0, JSON.stringify(errors));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
