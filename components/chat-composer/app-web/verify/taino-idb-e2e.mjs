// E3c 端到端：IDB 持久化（FM09）+ 菜单悬停高亮。
// 判据（D020）：
//   IDB：提交 → IDB 有记录（scope JSON）；reload → outbox 恢复 + 草稿恢复；
//        未提交草稿 reload 后保留（FM09「更新的草稿原样保留」）。
//   悬停：hover 第 N 项 → aria-selected 到位（TS onHighlight 契约）。
import { writeFile, mkdir, cp } from "node:fs/promises";
import { chromium } from "playwright-core";
import { startStaticServer, INDEX_HTML } from "./static-server.mjs";

const distRoot = new URL("./dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await mkdir(distRoot, { recursive: true });
await cp(new URL("../vendor/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), distRoot, { recursive: true });
await writeFile(distRoot + "index.html", INDEX_HTML);

const scope = `idb-e2e-${Date.now()}`; // IDB 跨 reload 持久：唯一 scope 隔离每次验证
const launchChannel = () => {
  const channel = process.env.CE_BROWSER_CHANNEL;
  return channel && channel !== "chromium" ? channel : undefined;
};
const server = await startStaticServer(distRoot);
const browser = await chromium.launch({ channel: launchChannel(), headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => { const t = m.text(); if (m.type() === "error" || t.startsWith("idb:")) console.log("[console]", t.slice(0, 160)); });

const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: Boolean(cond), detail }); console.log(`${cond ? "✔" : "✖"} ${name}${cond ? "" : ` — ${detail}`}`); };
const composerView = () => page.evaluate(() => window.__composerView());
const readIdb = (scope) => page.evaluate(async (scope) => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open("composer-rust-state", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return await new Promise((resolve) => {
    const tx = db.transaction("scope", "readonly");
    const req = tx.objectStore("scope").get(scope);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}, scope);

await page.goto(`${server.url}?editor=taino&scope=${scope}`);
await page.waitForFunction(() => window.__composerView !== undefined, { timeout: 30000 });
await page.waitForSelector('[contenteditable="true"]', { timeout: 15000 });

// 1. IDB 持久化：提交 → IDB 有记录
await page.evaluate(() => document.querySelector('[contenteditable="true"]').focus());
await page.keyboard.type("persisted hello");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.[0]?.status === "accepted", undefined, { timeout: 15000 });
// 防抖写循环落地：轮询 IDB 直到 accepted 提交进记录（最终态=最新快照）。
await page.waitForFunction(async (scope) => {
  const db = await new Promise((resolve) => {
    const req = indexedDB.open("composer-rust-state", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  if (!db) return false;
  const rec = await new Promise((resolve) => {
    const tx = db.transaction("scope", "readonly");
    const req = tx.objectStore("scope").get(scope);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
  const st = (() => { try { const pp = JSON.parse(rec ?? "null"); return pp ? pp.submissions.length + ":" + (pp.submissions[0]?.status ?? "-") + ":" + pp.draft.snapshot.text : "null"; } catch { return "unparsed"; } })();
  if (!window.__pollLog) window.__pollLog = [];
  window.__pollLog.push(st);
  return st.startsWith("1:accepted");
}, scope, { timeout: 15000, polling: 100 }).catch((e) => console.log("IDB poll timeout:", String(e).slice(0, 80)));
const record = await readIdb(scope);
const pollLog = await page.evaluate(() => window.__pollLog ?? []);
console.log("poll sequence:", JSON.stringify(pollLog.slice(0, 10)));
const parsed = (() => { try { return JSON.parse(record); } catch { return null; } })();
console.log("1 parsed:", JSON.stringify({
  keys: parsed ? Object.keys(parsed) : null,
  draftText: parsed?.draft?.snapshot?.text,
  subs: parsed?.submissions?.length,
  sub0: parsed?.submissions?.[0]?.status,
}));
check("1a IDB 有记录", typeof record === "string" && record.includes("persisted hello"), typeof record === "string" ? record.slice(0, 120) : JSON.stringify(record));
check("1b 记录含 accepted 提交", parsed?.submissions?.[0]?.status === "accepted", JSON.stringify(parsed?.submissions?.[0]?.status ?? "unparsed"));


// 2. reload 恢复（FM09）：outbox Accepted 恢复
await page.reload();
await page.waitForFunction(() => window.__composerView !== undefined, { timeout: 30000 });
await page.waitForSelector('[contenteditable="true"]', { timeout: 15000 });
await page.waitForTimeout(400);
let view = await composerView();
check("2a reload 后 outbox 恢复（FM09）", view.state.submissions[0]?.status === "accepted"
  && view.state.submissions[0]?.snapshot?.text === "persisted hello", JSON.stringify(view.state.submissions));

// 3. 未提交草稿 reload 保留（FM09：更新的草稿原样保留）
await page.evaluate(() => document.querySelector('[contenteditable="true"]').focus());
await page.keyboard.type("draft survives");
await page.waitForTimeout(500);
await page.reload();
await page.waitForFunction(() => window.__composerView !== undefined, { timeout: 30000 });
await page.waitForSelector('[contenteditable="true"]', { timeout: 15000 });
await page.waitForTimeout(400);
view = await composerView();
check("3 未提交草稿 reload 保留（FM09）", view.state.draft.snapshot.text === "draft survives", JSON.stringify(view.state.draft.snapshot.text));

// 4. 悬停高亮（TS onHighlight 契约）
await page.evaluate(() => document.querySelector('[contenteditable="true"]').focus());
await page.keyboard.type("@");
await page.waitForFunction(() => document.querySelector('[data-testid="candidate-menu"]') !== null, undefined, { timeout: 10000 });
const before = await page.evaluate(() => document.querySelector(".candidate.highlighted")?.textContent);
await page.hover('[data-index="2"]');
await page.waitForTimeout(300);
const after = await page.evaluate(() => document.querySelector(".candidate.highlighted")?.textContent);
check("4 悬停定位高亮（第 3 项）", before !== after && after !== null, JSON.stringify({ before, after }));

check("5a 零未捕获页面错误", errors.length === 0, JSON.stringify(errors));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
