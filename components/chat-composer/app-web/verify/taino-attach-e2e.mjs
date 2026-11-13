// E3b 端到端：附件/图文调位（composer-intake + composer-reorder + taino 线）。
// 判据（D019）：
//   intake 接受 → rail 卡片（名称/大小）+ attachment_ids 进草稿快照；
//   intake 拒绝（超限）→ 拒绝提示、rail 不变；移除 → 卡片消失 + ids 更新；
//   前移/后移 → 顺序重排（纯数学面）；附件+文本提交 → outbox 快照带 attachment_ids；
//   附件-only（无文本）→ 可提交（has_content 的附件面）。
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
const cardIds = () => page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-testid="attachment-card"]')).map((el) => el.getAttribute("data-asset-id")));
const freshPage = async () => {
  // 唯一 scope（E3c IDB 持久化后跨段隔离）+ rail 渲染等待。
  const scope = `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto(`${server.url}?editor=taino&scope=${scope}`);
  await page.waitForFunction(() => window.__composerView !== undefined, { timeout: 30000 });
  await page.waitForSelector('[data-testid="attachment-input"]', { timeout: 15000 });
};
const upload = async (files) => {
  await page.setInputFiles('[data-testid="attachment-input"]', files);
  await page.waitForTimeout(500);
};

// 1. intake 接受：卡片 + ids 进草稿快照
await freshPage();
await upload([{ name: "report.txt", mimeType: "text/plain", buffer: Buffer.from("hello attachment") }]);
let cards = await cardIds();
check("1a 卡片出现（名称+大小）", await page.evaluate(() => document.querySelector(".attachment-name")?.textContent) === "report.txt"
  && await page.evaluate(() => document.querySelector(".attachment-meta")?.textContent) === "16 B", JSON.stringify(cards));
let view = await composerView();
check("1b attachment_ids 进草稿快照", JSON.stringify(view.state.draft.snapshot.attachment_ids) === JSON.stringify(cards), JSON.stringify(view.state.draft.snapshot.attachment_ids));

// 2. 追加第二个附件 + 前移/后移重排
await upload([{ name: "shot.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }]);
cards = await cardIds();
check("2a 两张卡片（追加在尾）", cards?.length === 2, JSON.stringify(cards));
await page.evaluate(() => {
  const cards2 = Array.from(document.querySelectorAll('[data-testid="attachment-card"]'));
  cards2[1].querySelector('[data-testid="attachment-move-back"]').click();
});
await page.waitForTimeout(400);
const reordered = await cardIds();
check("2b 前移重排（第二张到首位）", reordered?.length === 2 && reordered[0] === cards[1] && reordered[1] === cards[0], JSON.stringify(reordered));
view = await composerView();
check("2c 快照 ids 同步重排", JSON.stringify(view.state.draft.snapshot.attachment_ids) === JSON.stringify(reordered), JSON.stringify(view.state.draft.snapshot.attachment_ids));

// 3. 移除
await page.evaluate(() => {
  const cards3 = Array.from(document.querySelectorAll('[data-testid="attachment-card"]'));
  cards3[0].querySelector('[data-testid="attachment-remove"]').click();
});
await page.waitForTimeout(400);
cards = await cardIds();
view = await composerView();
check("3 移除（卡片+ids 同步）", cards?.length === 1 && view.state.draft.snapshot.attachment_ids.length === 1
  && view.state.draft.snapshot.attachment_ids[0] === cards[0], JSON.stringify({ cards, ids: view.state.draft.snapshot.attachment_ids }));

// 4. 附件 + 文本提交 → outbox 快照带 attachment_ids
await page.evaluate(() => document.querySelector('[contenteditable="true"]').focus());
await page.keyboard.type("with file");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__composerView()?.state?.submissions?.length === 1, undefined, { timeout: 15000 });
view = await composerView();
check("4a 提交 Accepted", view.state.submissions[0]?.status === "accepted");
check("4b outbox 快照带 attachment_ids", view.state.submissions[0]?.snapshot?.attachment_ids?.length === 1, JSON.stringify(view.state.submissions[0]?.snapshot));

// 5. 附件-only（无文本）可提交（has_content 附件面）
await freshPage();
await upload([{ name: "only.bin", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3, 4]) }]);
await page.waitForSelector('[data-testid="attachment-card"]', { timeout: 10000 });
await page.evaluate(() => document.querySelector('[contenteditable="true"]').focus());
await page.keyboard.press("Enter");
let diag5 = null;
try {
  await page.waitForFunction(() => window.__composerView()?.state?.submissions?.length === 1, undefined, { timeout: 15000 });
} catch {
  diag5 = await page.evaluate(() => ({
    subs: window.__composerView()?.state?.submissions?.length,
    draft: window.__composerView()?.state?.draft?.snapshot?.text,
    ids: window.__composerView()?.state?.draft?.snapshot?.attachment_ids,
    railCards: document.querySelectorAll('[data-testid="attachment-card"]').length,
    focused: document.activeElement?.tagName,
  }));
}
view = await composerView();
if (diag5) console.log("5 diag:", JSON.stringify(diag5));
check("5 附件-only 可提交", view.state.submissions[0]?.status === "accepted"
  && view.state.submissions[0]?.snapshot?.attachment_ids?.length === 1, JSON.stringify(view.state.submissions[0]?.snapshot));

// 6. intake 拒绝：单文件超 5MB → 提示 + rail 不变
await freshPage();
await upload([{ name: "ok.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
const before = await cardIds();
await upload([{ name: "huge.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(6 * 1024 * 1024) }]);
const rejection = await page.evaluate(() => document.querySelector('[data-testid="intake-rejection"]')?.textContent ?? null);
check("6a 超限拒绝提示", rejection?.includes("huge.bin") === true, rejection);
check("6b rail 不变", JSON.stringify(await cardIds()) === JSON.stringify(before), JSON.stringify(await cardIds()));

// 7. 零未捕获错误
check("7a 零未捕获页面错误", errors.length === 0, JSON.stringify(errors));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
