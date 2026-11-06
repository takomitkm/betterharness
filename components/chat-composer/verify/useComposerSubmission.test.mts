import { startRender, useState as _unused } from "./react-shim.mjs";
void _unused;
await import("./gen-hook.mjs");
const { useComposerSubmission } = await import("./hook-gen.ts");

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
const check = (name: string, pass: boolean, detail?: string) => results.push({ name, pass, detail });

let submitted: string[] = [];
let rejectNext = false;
const onSubmit = (t: string) => {
  submitted.push(t);
  return rejectNext ? Promise.reject(new Error("send-failed")) : Promise.resolve();
};

function render() { startRender(); return useComposerSubmission(onSubmit); }

// 1) 空文本 submit → 不发送
submitted = [];
let c = render();
c.submit();
check("空文本不提交", submitted.length === 0);

// 2) 正常提交：立即清空 + 在途
c = render();
c.setText("A");
c = render();
c.submit();
check("受理即清空", render().text === "", render().text);
check("在途标记", render().inFlight === true);

// 3) 在途再 submit / handleEnter → no-op
c = render();
c.submit();                                  // 第二下
c = render();
check("双击只发 1 条", submitted.length === 1, String(submitted.length));

const evNoop = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, preventDefault: () => { /* */ } };
let prevented = 0;
const evInflight = { ...evNoop, preventDefault: () => { prevented++; } };
c = render();
c.handleEnter(evInflight);
c = render();
check("在途 Enter 被消费(preventDefault)", prevented === 1, String(prevented));
check("在途 Enter 不改文本", render().text === "", render().text);
check("在途 Enter 不再发送", submitted.length === 1, String(submitted.length));

// 4) IME / Shift 放行（不 preventDefault）
prevented = 0;
c = render();
c.handleEnter({ ...evInflight, isComposing: true });
c.handleEnter({ ...evInflight, shiftKey: true });
check("IME/Shift 不消费", prevented === 0, String(prevented));

// 5) 成功结算：inFlight 解除
await new Promise((r) => setTimeout(r, 30));
c = render();
check("成功后解除在途", c.inFlight === false);
check("成功计数", c.sentCount === 1);

// 6) 失败 + 空编辑器 → 恢复快照
submitted = [];
rejectNext = true;
c = render();
c.setText("B");
c = render();
c.submit();
await new Promise((r) => setTimeout(r, 30));
c = render();
check("失败恢复原文", c.text === "B", c.text);
check("失败入列", c.failed.length === 1 && c.failed[0]!.text === "B");

// 7) 失败 + 用户已写新草稿 → 新草稿保留，失败项单独记录
submitted = [];
c = render();
c.setText("C");
c = render();
c.submit();
await new Promise((r) => setTimeout(r, 10));
c = render();
c.setText("D-new");           // 发送期间用户已写新内容
await new Promise((r) => setTimeout(r, 30));
c = render();
check("新草稿不被覆盖", c.text === "D-new", c.text);
check("失败项单独记录", c.failed.length === 2 && c.failed[1]!.text === "C", JSON.stringify(c.failed));

// 8) 成功路径下写新草稿不受结算影响
submitted = [];
rejectNext = false;
c = render();
c.setText("E");
c = render();
c.submit();
await new Promise((r) => setTimeout(r, 10));
c = render();
c.setText("F-new");
await new Promise((r) => setTimeout(r, 30));
c = render();
check("成功后新草稿保留", c.text === "F-new", c.text);
check("成功计数累计", c.sentCount === 2, String(c.sentCount));

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? "PASS" : "FAIL") + "  " + r.name + (r.detail ? "  [" + r.detail + "]" : ""));
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
Deno.exit(failed.length === 0 ? 0 : 1);
