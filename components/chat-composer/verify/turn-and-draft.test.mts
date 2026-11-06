import { startRender, __resetSlots } from "./react-shim.mjs";
await import("./gen-hook.mjs");
const { useComposerSubmission } = await import("./hook-gen.ts");

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
const check = (name: string, pass: boolean, detail?: string) =>
  results.push({ name, pass, detail });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let submitted: string[] = [];
let rejectNext = false;
const onSubmit = (t: string) => {
  submitted.push(t);
  return rejectNext ? Promise.reject(new Error("send-failed")) : Promise.resolve();
};

// mock storage（记录每次写入，便于断言"同步清空"）
class MockStorage {
  map = new Map<string, string>();
  writes: Array<{ key: string; value: string | null }> = [];
  get(key: string) { return this.map.get(key) ?? null; }
  set(key: string, value: string | null) {
    this.writes.push({ key, value });
    if (value === null) this.map.delete(key);
    else this.map.set(key, value);
  }
}

// ── A. 生成中排队（busyEnter=queue，ZCode/Claude Code 语义）
{
  __resetSlots();
  submitted = [];
  rejectNext = false;
  let c = render();
  c.beginTurn();
  c = render();
  check("A0: turn 开始 → 生成中", c.isGenerating === true);

  c.setText("A");
  c = render();
  c.submit();
  await sleep(30);
  c = render();
  check("A1: 首条已发（在途解除，生成仍在）", c.sentCount === 1 && c.inFlight === false && c.isGenerating === true, `sent=${c.sentCount} inflight=${c.inFlight} gen=${c.isGenerating}`);

  c.setText("B");
  c = render();
  c.handleEnter({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, preventDefault: () => {} });
  c = render();
  check("A2: 生成中 Enter → 入队", c.queue.length === 1 && c.queue[0] === "B", JSON.stringify(c.queue));
  check("A3: 入队后编辑器清空", c.text === "", c.text);
  check("A4: 排队不立即发送", submitted.length === 1, String(submitted.length));

  c.setText("C");
  c = render();
  c.handleEnter({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, preventDefault: () => {} });
  c = render();
  check("A5: 可继续排多条", c.queue.length === 2 && c.queue[1] === "C", JSON.stringify(c.queue));

  c.endTurn();
  c = render();
  check("A6: endTurn → 生成结束", c.isGenerating === false);
  await sleep(60);
  c = render();
  check("A7: 队列在轮末自动发出（B、C 都发）", submitted.includes("B") && submitted.includes("C"), JSON.stringify(submitted));
  check("A8: 队列清空", c.queue.length === 0);
}

// ── B. steer（Codex 语义：并入当前轮，不排队）
{
  __resetSlots();
  submitted = [];
  rejectNext = false;
  let c = render({ busyEnter: "steer" });
  c.beginTurn();
  c.setText("A");
  c = render(({ busyEnter: "steer" }));
  c.submit();
  await sleep(30);
  c.setText("S");
  c = render(({ busyEnter: "steer" }));
  c.handleEnter({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, preventDefault: () => {} });
  c = render(({ busyEnter: "steer" }));
  check("B1: steer 直接发送（不排队）", submitted.includes("S") && c.queue.length === 0, JSON.stringify({ q: c.queue, s: submitted }));
  check("B2: steer 后编辑器清空", c.text === "", c.text);
  c.endTurn();
}

// ── C. busyEnter=none：保留草稿不投递
{
  __resetSlots();
  submitted = [];
  rejectNext = false;
  let c = render({ busyEnter: "none" });
  c.beginTurn();
  c.setText("D");
  c = render(({ busyEnter: "none" }));
  c.handleEnter({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, preventDefault: () => {} });
  c = render(({ busyEnter: "none" }));
  check("C1: none → 草稿保留", c.text === "D", c.text);
  check("C2: none → 不发送不入队", submitted.length === 0 && c.queue.length === 0);
  c.endTurn();
}

// ── D. ↑ 取回（popQueueToEditor）
{
  __resetSlots();
  submitted = [];
  rejectNext = false;
  let c = render();
  c.beginTurn();
  c.setText("E");
  c = render();
  c.submit();
  await sleep(30);
  c.setText("F");
  c = render();
  c.handleEnter({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, preventDefault: () => {} });
  c = render();
  check("D0: 前置队列 [E 的下一轮 F]", c.queue.length === 1);

  // 编辑器非空 → 不取回（不覆盖用户输入）
  c.setText("user-input");
  c = render();
  const out1 = c.popQueueToEditor();
  c = render();
  check("D1: 编辑器非空 → 取回 null", out1 === null && c.text === "user-input", JSON.stringify({ out1, text: c.text }));

  c.setText("");
  c = render();
  const out2 = c.popQueueToEditor();
  c = render();
  check("D2: 取回最近排队的一条", out2 === "F" && c.text === "F", JSON.stringify({ out2, text: c.text }));
  check("D3: 队列少一条", c.queue.length === 0, JSON.stringify(c.queue));

  const out3 = c.popQueueToEditor();
  check("D4: 空队列 → null", out3 === null);
  c.endTurn();
}

// ── E. 草稿持久化
{
  __resetSlots();
  submitted = [];
  rejectNext = false;
  const storage = new MockStorage();
  let c = render({ draftKey: "d1", storage });
  void c;
  // 第一次挂载：无草稿
  c = render({ draftKey: "d1", storage });
  check("E0: 无草稿时初始为空", c.text === "", c.text);

  c.setText("hello");
  c = render(({ draftKey: "d1", storage }));
  check("E1: 防抖期内还没落盘", storage.map.get("d1") === undefined, JSON.stringify([...storage.map]));
  await sleep(400);
  check("E2: 防抖后落盘", storage.map.get("d1") === "hello", storage.map.get("d1"));

  // 重新挂载（模拟刷新）：草稿恢复
  __resetSlots();
  c = render({ draftKey: "d1", storage });
  check("E3: 重挂载恢复草稿", c.text === "hello", c.text);

  // 提交：受理必须同步清空草稿（不等防抖）——ZCode bug 的另一半
  const writesBefore = storage.writes.length;
  c = render({ draftKey: "d1", storage });
  console.log("  [diag] pre-submit: text=", JSON.stringify(c.text), "inFlight=", c.inFlight, "writes=", JSON.stringify(storage.writes));
  c.submit();
  console.log("  [diag] post-submit: writes=", JSON.stringify(storage.writes), "text=", JSON.stringify(c.text), "inFlight=", c.inFlight);
  const claimWrite = storage.writes.slice(writesBefore).find((w) => w.key === "d1");
  check("E4: 受理同步清空草稿（不等防抖）", claimWrite !== undefined && claimWrite.value === "", JSON.stringify(storage.writes.slice(writesBefore)));
  await sleep(30);
  c = render(({ draftKey: "d1", storage }));
  check("E5: 发送成功后草稿仍为空（不复活已发正文）", storage.map.get("d1") === "" || storage.map.get("d1") === undefined, storage.map.get("d1"));

  // 失败 → 快照写回草稿
  rejectNext = true;
  c = render({ draftKey: "d1", storage });
  c.setText("will-fail");
  c = render(({ draftKey: "d1", storage }));
  c.submit();
  await sleep(420);
  c = render(({ draftKey: "d1", storage }));
  check("E6: 失败恢复后草稿=快照", storage.map.get("d1") === "will-fail", storage.map.get("d1"));
  check("E7: 编辑器=快照", c.text === "will-fail");
}

// ── F. 排队消息发送失败 → 不被静默吞掉
{
  __resetSlots();
  submitted = [];
  rejectNext = false;
  let c = render();
  c.beginTurn();
  c.setText("G");
  c = render();
  c.submit();
  await sleep(30);
  rejectNext = true;
  c.setText("H-fail");
  c = render();
  c.handleEnter({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, preventDefault: () => {} });
  c.endTurn();
  await sleep(60);
  c = render();
  check("F1: 排队消息发送失败 → 记入失败项", c.failed.some((f) => f.text === "H-fail"), JSON.stringify(c.failed));
}

function render(opts: { busyEnter?: "queue" | "steer" | "none"; draftKey?: string } = {}) {
  startRender();
  return useComposerSubmission({ onSubmit, ...opts });
}

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? "PASS" : "FAIL") + "  " + r.name + (r.detail ? "  [" + r.detail + "]" : ""));
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
Deno.exit(failed.length === 0 ? 0 : 1);