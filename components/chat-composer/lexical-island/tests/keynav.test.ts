// 失效模式清单（writing-tests 阶段 1）——Lexical Island Vanilla Controller PoC。
// 每条 = 失效类别 / 机制 / 注入手段 / 观察什么；用例绑定清单条目；红绿见各测试注释。
//
// | # | 失效类别 | 机制 | 注入手段 | 观察 |
// | 1 | 双重初始化 | 同容器二次 mount | 二次 createController 同容器 | 显式报错 |
// | 2 | 销毁残留 | destroy 后监听/root/placeholder 残留 | destroy + 断言容器空、组合事件不再触发 | 资源归零 |
// | 3 | React 泄漏 | 依赖图混入 @lexical/react 或 react | esbuild metafile 审计 | 构建产物零 React |
// | 4 | IME 组合中 Enter 误发 | Safari/WebView 组合结束后补发 Enter | 合成 composition 事件 + Enter | 无 submit-request |
// | 5 | 组合结束宽限窗内 Enter 误发 | 10ms 严格小于边界 | 注入时钟推进 | hand-to-ime |
// | 6 | Shift+Enter 误提交 | newline 判定 | Shift+Enter | newline 且不拦截默认 |
// | 7 | repeat 连发 | 按住不放 | repeat=true | 吞掉 |
// | 8 | 非 Enter 键误拦 | 方向键/字母 | dispatch | 不拦截 |
// | 9 | getDocument 上下文 | editorState.read 外调用 | 封装内 read | 正常返回 |
// | 10 | setDocument 污染撤销栈 | 恢复后 undo 回到恢复前 | setDocument + undo | 撤销栈不穿越恢复点 |
// | 11 | 禁用后仍可输入 | setEditable(false) | setDisabled + 输入 | 无变化 |
// | 12 | 多实例互相干扰 | 两容器并行 | 双 mount | 事件互不串 |
// 排除（理由）：附件节点/剪贴板 MIME/菜单仲裁——A3 集成阶段（计划 §4.7 PoC 范围外）。
// 红绿说明：4/5/6/7/8 直接绑定 KD 契约（archive 红绿已校准）；2/3 的红 = 删除守卫后必红
// （实现层断言/清理解除即红），首次运行以探针确认。

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEnter, ImeTracker, type EnterDecisionInput } from "../src/keynav.ts";

function input(nowMs: number, overrides: Partial<EnterDecisionInput> = {}): EnterDecisionInput {
  return { key: "Enter", nowMs, ...overrides };
}

/// KD01：组合进行中把 Enter 交给输入法，且不拦截浏览器默认行为。
test("KD01 composing hands Enter to IME without blocking", () => {
  const verdict = decideEnter(input(100, { isComposing: true }));
  assert.deepEqual(verdict, { kind: "hand-to-ime", preventDefault: false });
  const verdict2 = decideEnter(input(100, { composing: true }));
  assert.equal(verdict2.kind, "hand-to-ime");
  assert.equal(verdict2.preventDefault, false);
});

/// KD02：老式 keyCode 229 即使 isComposing=false 也交给输入法。
test("KD02 legacy keyCode 229 hands to IME", () => {
  const verdict = decideEnter(input(100, { keyCode: 229 }));
  assert.equal(verdict.kind, "hand-to-ime");
  assert.equal(verdict.preventDefault, false);
  const other = decideEnter(input(100, { keyCode: 13, canSubmit: true }));
  assert.equal(other.kind, "submit");
});

/// KD03：宽限窗口严格小于 IME_GRACE_MS。
test("KD03 grace window strict boundary", () => {
  const tracker = new ImeTracker();
  tracker.onCompositionStart();
  tracker.onCompositionEnd(1000);
  assert.equal(tracker.isComposing(1000 + 10 - 1).composing, true);
  assert.equal(tracker.isComposing(1000 + 10).composing, false);
});

/// KD04：Shift/Alt+Enter 换行且不拦截。
test("KD04 shift or alt enter is newline", () => {
  for (const overrides of [{ shiftKey: true }, { altKey: true }]) {
    const verdict = decideEnter(input(100, { canSubmit: true, ...overrides }));
    assert.deepEqual(verdict, { kind: "newline", preventDefault: false });
  }
});

/// KD06：repeat 连发吞掉；KD07：不可提交吞掉；KD08：非 Enter 不拦。
test("KD06/07/08 repeat, unsubmittable, non-Enter", () => {
  assert.deepEqual(decideEnter(input(100, { repeat: true, canSubmit: true })), { kind: "noop", preventDefault: true });
  assert.deepEqual(decideEnter(input(100)), { kind: "noop", preventDefault: true });
  assert.deepEqual(decideEnter(input(100, { key: "a", canSubmit: true })), { kind: "noop", preventDefault: false });
});

/// KD09：Ctrl/Meta+Enter 仍提交。
test("KD09 ctrl or meta enter submits", () => {
  for (const overrides of [{ ctrlKey: true }, { metaKey: true }]) {
    const verdict = decideEnter(input(100, { canSubmit: true, ...overrides }));
    assert.deepEqual(verdict, { kind: "submit", preventDefault: true });
  }
});

/// KD10：ImeTracker 生命周期（开始/结束/宽限/重启/重置）。
test("KD10 ime tracker lifecycle", () => {
  const tracker = new ImeTracker();
  assert.equal(tracker.isComposing(0).composing, false);
  tracker.onCompositionStart();
  assert.equal(tracker.isComposing(50).composing, true);
  tracker.onCompositionEnd(50);
  assert.equal(tracker.isComposing(55).composing, true, "宽限窗口内仍视为组合中");
  assert.equal(tracker.isComposing(60).composing, false);
  tracker.onCompositionStart();
  assert.equal(tracker.isComposing(60).composing, true, "重启组合");
  tracker.reset();
  assert.equal(tracker.isComposing(60).composing, false);
  assert.equal(tracker.isComposing(60).composingUntilMs, 0);
});

/// KD11：真实 ImeTracker 快照喂给 decideEnter，宽限边界成立。
test("KD11 decideEnter honors tracker snapshot boundary", () => {
  const tracker = new ImeTracker();
  tracker.onCompositionStart();
  tracker.onCompositionEnd(500);
  const snapshot = tracker.isComposing(505);
  const verdict = decideEnter(input(505, { composing: snapshot.composing, composingUntilMs: snapshot.composingUntilMs, canSubmit: true }));
  assert.equal(verdict.kind, "hand-to-ime");
  const snapshot2 = tracker.isComposing(510);
  const verdict2 = decideEnter(input(510, { composing: snapshot2.composing, composingUntilMs: snapshot2.composingUntilMs, canSubmit: true }));
  assert.deepEqual(verdict2, { kind: "submit", preventDefault: true });
});
