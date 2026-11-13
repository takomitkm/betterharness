// E3d 端到端：不可靠网络场景（场景化回环 executor + composerTest 注入钩子）。
// 判据（D021）——与 React 线 demo2-wasm 的 durability 面一一同源：
//   丢 ack → uncertain（FM04 语义）；LookupResult accepted 恢复（FM25 路径）；
//   迟到 AttemptTimeout 不降级；uncertain 阻塞后续提交入队（FM05 面之一）；
//   rejected → 原样重试（保留身份）→ accepted；菜单点击选择（Pick）。
import { writeFile, mkdir, cp } from "node:fs/promises";
import { chromium } from "playwright-core";
import { startStaticServer, INDEX_HTML } from "./static-server.mjs";

const distRoot = new URL("./dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await mkdir(distRoot, { recursive: true });
await cp(new URL("../vendor/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), distRoot, { recursive: true });
await writeFile(distRoot + "index.html", INDEX_HTML);

const launchChannel = () => {
  const channel = process.env.CE_BROWSER_CHANNEL;
  return channel && channel !== "chromium" ? channel : undefined;
};
const server = await startStaticServer(distRoot);
const browser = await chromium.launch({ channel: launchChannel(), headless: true });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: Boolean(cond), detail }); console.log(`${cond ? "✔" : "✖"} ${name}${cond ? "" : ` — ${detail}`}`); };
const composerView = () => page.evaluate(() => window.__composerView());
const freshPage = async (query) => {
  const scope = `net-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto(`${server.url}?editor=taino&scope=${scope}${query ? `&${query}` : ""}`);
  await page.waitForFunction(() => window.__composerView !== undefined, { timeout: 30000 });
  await page.waitForSelector('[contenteditable="true"]', { timeout: 15000 });
  await page.evaluate(() => document.querySelector('[contenteditable="true"]').focus());
};
const typeAndSubmit = async (text) => {
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
};

// ═══ 1. 丢 ack → uncertain（FM04：未确认不重发）═══
await freshPage("scenario=uncertain");
await typeAndSubmit("lost ack msg");
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[0]?.status === "uncertain", undefined, { timeout: 15000 });
let view = await composerView();
check("1a 丢 ack → uncertain", view.state.submissions[0]?.status === "uncertain");
check("1b uncertain 无轮次开立（未确认不入轮）", !view.state.active_turn, view.state.active_turn);

// ═══ 2. LookupResult accepted → 状态翻转（FM25 查询恢复路径）═══
await page.evaluate(() => window.__composerTest({
  kind: "lookup",
  id: window.__composerView().state.submissions[0].id,
  status: "accepted",
}));
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[0]?.status === "accepted", undefined, { timeout: 15000 });
view = await composerView();
check("2 LookupResult 恢复 accepted（FM25）", view.state.submissions[0]?.status === "accepted");

// ═══ 3. 迟到 AttemptTimeout 不降级（FM04：终态不被超时覆盖）═══
await page.evaluate(() => window.__composerTest({
  kind: "timeout",
  id: window.__composerView().state.submissions[0].id,
  attempt: window.__composerView().state.submissions[0].attemptId,
}));
await page.waitForTimeout(600);
view = await composerView();
check("3 迟到超时不降级", view.state.submissions[0]?.status === "accepted", view.state.submissions[0]?.status);

// ═══ 4. rejected → 原样重试（保留身份）→ accepted ═══
await freshPage("scenario=reject");
await typeAndSubmit("will be rejected");
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[0]?.status === "rejected", undefined, { timeout: 15000 });
view = await composerView();
const rejectedId = view.state.submissions[0].id;
check("4a rejected（宿主明确拒绝）", view.state.submissions[0]?.status === "rejected");
await page.evaluate(() => window.__composerTest({ kind: "scenario", value: "accept" }));
await page.getByTestId("retry").first().click();
let diag4b = null;
try {
  await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[0]?.status === "accepted", undefined, { timeout: 15000 });
} catch {
  diag4b = await page.evaluate(() => ({
    submissions: window.__composerView()?.state?.submissions?.map((x) => ({ id: x.id, status: x.status, attempts: x.attempts })),
    buttons: Array.from(document.querySelectorAll('[data-testid="retry"]')).length,
  }));
}
view = await composerView();
if (diag4b) console.log("4b diag:", JSON.stringify(diag4b));
check("4b 原样重试 → accepted（同身份）", view.state.submissions[0]?.id === rejectedId
  && view.state.submissions[0]?.status === "accepted", JSON.stringify({ id: view.state.submissions[0]?.id, rejectedId }));

// ═══ 5. uncertain 阻塞队列：第二条提交 queued，查询恢复后 pump 派发 ═══
await freshPage("scenario=uncertain");
await typeAndSubmit("first blocked");
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[0]?.status === "uncertain", undefined, { timeout: 15000 });
await typeAndSubmit("second queued");
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.length === 2, undefined, { timeout: 15000 });
view = await composerView();
check("5a uncertain 阻塞下第二条 queued（FM05 面之一）", view.state.submissions[1]?.status === "queued", view.state.submissions[1]?.status);
await page.evaluate(() => window.__composerTest({ kind: "scenario", value: "accept" }));
await page.evaluate(() => window.__composerTest({ kind: "lookup", id: window.__composerView().state.submissions[0].id, status: "accepted" }));
let diag5b = null;
try {
  await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[0]?.status === "accepted", undefined, { timeout: 15000 });
} catch {
  diag5b = await page.evaluate(() => window.__composerView()?.state?.submissions?.map((x) => x.status));
}
view = await composerView();
if (diag5b) console.log("5b diag:", JSON.stringify(diag5b));
check("5b 查询恢复 accepted（FM25）", view.state.submissions[0]?.status === "accepted");
// turn 闸门（FM12）：lookup 恢复后 queued 保持 queued——等 end_turn 派发，不自动派发。
check("5c turn 闸门：queued 保持排队", view.state.submissions[1]?.status === "queued", view.state.submissions[1]?.status);
await page.evaluate(() => window.__composerTest({ kind: "scenario", value: "accept" }));
await page.getByTestId("end-turn").click();
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[1]?.status === "accepted", undefined, { timeout: 15000 });
check("5d end_turn 派发第二条（FM12）", (await composerView()).state.submissions[1]?.status === "accepted");

// ═══ 6. 菜单点击选择（Pick）═══
await freshPage();
await page.keyboard.type("@");
await page.waitForFunction(() => document.querySelector('[data-testid="candidate-menu"]') !== null, undefined, { timeout: 10000 });
await page.click('[data-index="2"]');
await page.waitForTimeout(400);
view = await composerView();
if (view.state.submissions.length !== 1) {
  console.log("6 diag:", JSON.stringify({
    subs: view.state.submissions?.length,
    menuOpen: await page.evaluate(() => !!document.querySelector('[data-testid="candidate-menu"]')),
    text: await page.evaluate(() => document.querySelector('[contenteditable="true"]')?.textContent),
  }));
}
check("6 菜单点击第 3 项接受（Pick：替换写回，不提交）", view.state.submissions.length === 0
  && view.state.draft.snapshot.text === "@s1-alpha.md ", JSON.stringify(view.state.draft.snapshot.text));

check("7a 零未捕获页面错误", errors.length === 0, JSON.stringify(errors));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
