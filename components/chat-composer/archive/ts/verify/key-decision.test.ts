import { test } from "node:test";
import assert from "node:assert/strict";
import { IME_GRACE_MS, ImeTracker, decideEnter } from "../key-decision.ts";

// decideEnter 的基准输入：普通 Enter、无修饰键、无组合、可提交、无菜单。
function enterInput(overrides: Partial<Parameters<typeof decideEnter>[0]> = {}): Parameters<typeof decideEnter>[0] {
  return {
    key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
    isComposing: false, keyCode: 13, repeat: false,
    composing: false, composingUntilMs: 0, nowMs: 1000,
    hasMenu: false, canSubmit: true, ...overrides,
  };
}

test("KD01: composition in progress hands Enter to the IME and does not block the browser", () => {
  assert.deepEqual(decideEnter(enterInput({ isComposing: true })), { kind: "hand-to-ime", preventDefault: false });
  assert.deepEqual(decideEnter(enterInput({ composing: true })), { kind: "hand-to-ime", preventDefault: false });
  // 两条决策独立：停掉编辑器的 Enter 后备 ≠ 阻止浏览器确认候选。
  assert.equal(decideEnter(enterInput({ isComposing: true })).preventDefault, false);
});

test("KD02: legacy keyCode 229 hands Enter to the IME even when isComposing is false", () => {
  assert.deepEqual(
    decideEnter(enterInput({ keyCode: 229, isComposing: false, composing: false })),
    { kind: "hand-to-ime", preventDefault: false },
  );
});

test("KD03: the post-composition grace window is strict and exactly IME_GRACE_MS", () => {
  assert.equal(IME_GRACE_MS, 10);
  const endedAt = 1000;
  const until = endedAt + IME_GRACE_MS;
  assert.deepEqual(
    decideEnter(enterInput({ composingUntilMs: until, nowMs: endedAt + 5 })),
    { kind: "hand-to-ime", preventDefault: false },
  );
  // 精确边界：T+9 仍在宽限期内。
  assert.deepEqual(
    decideEnter(enterInput({ composingUntilMs: until, nowMs: endedAt + 9 })),
    { kind: "hand-to-ime", preventDefault: false },
  );
  // 严格小于：T+10 不再是宽限期，普通 Enter 应当提交。
  assert.deepEqual(
    decideEnter(enterInput({ composingUntilMs: until, nowMs: endedAt + 10 })),
    { kind: "submit", preventDefault: true },
  );
});

test("KD04: Shift/Alt+Enter is a newline that leaves the browser default alone", () => {
  assert.deepEqual(decideEnter(enterInput({ shiftKey: true })), { kind: "newline", preventDefault: false });
  assert.deepEqual(decideEnter(enterInput({ altKey: true })), { kind: "newline", preventDefault: false });
  // 换行优先于菜单与 repeat：按住 Shift+Enter 也只是换行。
  assert.deepEqual(decideEnter(enterInput({ shiftKey: true, hasMenu: true })), { kind: "newline", preventDefault: false });
  assert.deepEqual(decideEnter(enterInput({ altKey: true, repeat: true })), { kind: "newline", preventDefault: false });
});

test("KD05: an open candidate menu consumes Enter before repeat/submit can act", () => {
  assert.deepEqual(decideEnter(enterInput({ hasMenu: true })), { kind: "menu", preventDefault: true });
  assert.deepEqual(decideEnter(enterInput({ hasMenu: true, repeat: true })), { kind: "menu", preventDefault: true });
  // 组合中的菜单 Enter 仍先交给输入法。
  assert.deepEqual(
    decideEnter(enterInput({ hasMenu: true, isComposing: true })),
    { kind: "hand-to-ime", preventDefault: false },
  );
});

test("KD06: held-key repeat is a preventing no-op even when the draft is submittable", () => {
  assert.deepEqual(decideEnter(enterInput({ repeat: true })), { kind: "noop", preventDefault: true });
  assert.deepEqual(decideEnter(enterInput({ repeat: true, canSubmit: true })), { kind: "noop", preventDefault: true });
});

test("KD07: a draft that cannot submit is a preventing no-op", () => {
  assert.deepEqual(decideEnter(enterInput({ canSubmit: false })), { kind: "noop", preventDefault: true });
  assert.deepEqual(decideEnter(enterInput({ canSubmit: false, repeat: false })), { kind: "noop", preventDefault: true });
});

test("KD08: keys other than Enter are explicitly not ours and never blocked", () => {
  assert.deepEqual(decideEnter(enterInput({ key: "ArrowUp" })), { kind: "noop", preventDefault: false });
  assert.deepEqual(decideEnter(enterInput({ key: "a" })), { kind: "noop", preventDefault: false });
});

test("KD09: Ctrl/Meta+Enter still submits (documented contract; engine semantics unchanged)", () => {
  assert.deepEqual(decideEnter(enterInput({ ctrlKey: true })), { kind: "submit", preventDefault: true });
  assert.deepEqual(decideEnter(enterInput({ metaKey: true })), { kind: "submit", preventDefault: true });
});

test("KD10: ImeTracker lifecycle: start, end, grace, restart and reset", () => {
  const ime = new ImeTracker();
  assert.deepEqual(ime.isComposing(5000), { composing: false, composingUntilMs: 0 });
  ime.onCompositionStart();
  assert.deepEqual(ime.isComposing(5000), { composing: true, composingUntilMs: 0 });
  ime.onCompositionEnd(5000);
  assert.deepEqual(
    ime.isComposing(5000 + IME_GRACE_MS - 1),
    { composing: true, composingUntilMs: 5000 + IME_GRACE_MS },
  );
  // 严格小于：T+10 起不再报告组合中。
  assert.deepEqual(
    ime.isComposing(5000 + IME_GRACE_MS),
    { composing: false, composingUntilMs: 5000 + IME_GRACE_MS },
  );
  // 宽限期内再次开组合：composing 重新为真。
  ime.onCompositionStart();
  assert.equal(ime.isComposing(5000 + IME_GRACE_MS).composing, true);
  // 根元素替换：重置后回到初始状态，旧窗口不得残留。
  ime.reset();
  assert.deepEqual(ime.isComposing(5000 + IME_GRACE_MS + 100), { composing: false, composingUntilMs: 0 });
});

test("KD11: decideEnter fed by a real ImeTracker snapshot honors the grace boundary", () => {
  const ime = new ImeTracker();
  ime.onCompositionStart();
  ime.onCompositionEnd(2000);
  assert.deepEqual(
    decideEnter(enterInput({ ...ime.isComposing(2000 + IME_GRACE_MS - 1), nowMs: 2000 + IME_GRACE_MS - 1 })),
    { kind: "hand-to-ime", preventDefault: false },
  );
  assert.deepEqual(
    decideEnter(enterInput({ ...ime.isComposing(2000 + IME_GRACE_MS), nowMs: 2000 + IME_GRACE_MS })),
    { kind: "submit", preventDefault: true },
  );
});
