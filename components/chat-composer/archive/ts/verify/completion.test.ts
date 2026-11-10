import { test } from "node:test";
import assert from "node:assert/strict";
import { CompletionSession, applyPickToText, detectTrigger } from "../completion.ts";

// detectTrigger 的命中断言辅助：只比较关心的字段。
function hit(kind: "reference" | "slash", query: string, start: number, end: number) {
  return { kind, query, start, end };
}

test("CT01: @ triggers at text start, with an empty query when only the trigger is typed", () => {
  assert.deepEqual(detectTrigger("@fi", 3), hit("reference", "fi", 0, 3));
  assert.deepEqual(detectTrigger("@", 1), hit("reference", "", 0, 1));
  // 光标停在查询中间：命中区间以光标为端点（caret-relative token span）。
  assert.deepEqual(detectTrigger("@file", 3), hit("reference", "fi", 0, 3));
  // caret 0 与越界：明确无触发。
  assert.equal(detectTrigger("@fi", 0), null);
  assert.equal(detectTrigger("@fi", 4), null);
  assert.equal(detectTrigger("", 0), null);
});

test("CT02: @ triggers after whitespace or punctuation, not after a letter/number/underscore", () => {
  assert.deepEqual(detectTrigger("看 @a", 4), hit("reference", "a", 2, 4));
  assert.deepEqual(detectTrigger("(@a", 3), hit("reference", "a", 1, 3));
  assert.deepEqual(detectTrigger("。@文件", 4), hit("reference", "文件", 1, 4));
  // 邮箱/标识符形态：触发符前是字母、数字、下划线都拒绝。
  assert.equal(detectTrigger("mail@example.com", 16), null);
  assert.equal(detectTrigger("1@2", 3), null);
  assert.equal(detectTrigger("x_@y", 4), null);
  assert.equal(detectTrigger("a@b/c", 5), null);
});

test("CT03: the query cannot cross whitespace, and the nearest trigger wins", () => {
  assert.equal(detectTrigger("@a b", 4), null);
  assert.equal(detectTrigger("@a\nb", 4), null);
  // 块间不跨段：前一段文本 + 分隔符之后的新段不算同一 token。
  assert.deepEqual(detectTrigger("hello\n@fi", 9), hit("reference", "fi", 6, 9));
  // 最近触发符获胜：从光标向前先遇到 @，/ 虽然边界合法但更远。
  assert.deepEqual(detectTrigger("x./@y", 5), hit("reference", "y", 3, 5));
});

test("CT04: slash triggers with the same boundary rules, plus URL exclusions // and scheme:/", () => {
  assert.deepEqual(detectTrigger("/help", 5), hit("slash", "help", 0, 5));
  assert.deepEqual(detectTrigger(" /he", 4), hit("slash", "he", 1, 4));
  assert.deepEqual(detectTrigger("(/cmd", 5), hit("slash", "cmd", 1, 5));
  assert.deepEqual(detectTrigger("/", 1), hit("slash", "", 0, 1));
  // 字母/数字/下划线在前：路径与普通文本不开菜单。
  assert.equal(detectTrigger("a/he", 4), null);
  assert.equal(detectTrigger("1/he", 4), null);
  assert.equal(detectTrigger("_/he", 4), null);
  // URL 排除：// 序列（含空查询时后面紧跟 /）与 scheme:/。
  assert.equal(detectTrigger("https://example.com", 19), null);
  assert.equal(detectTrigger("//cdn.example.com", 17), null);
  assert.equal(detectTrigger("//", 2), null);
  assert.equal(detectTrigger("//", 1), null);
  assert.equal(detectTrigger("http:/x", 7), null);
  assert.equal(detectTrigger("S:/apps", 7), null);
  assert.equal(detectTrigger("时间:10/30", 8), null);
});

test("CT05: a session opens per query, and @a→@ab bumps the generation into pending", () => {
  const session = new CompletionSession();
  assert.equal(session.isOpen(), false);
  session.track({ kind: "reference", query: "a", start: 0, end: 2 }, 1);
  assert.equal(session.isOpen(), true);
  assert.equal(session.pending(), true);
  assert.equal(session.generation, 1);
  session.applyCandidates(session.generation, [{ label: "A", insertText: "@A" }]);
  assert.equal(session.pending(), false);
  assert.deepEqual([...session.candidates], [{ label: "A", insertText: "@A" }]);
  // 查询细化：换代次、清候选、回到 pending，旧结果不再可见。
  session.track({ kind: "reference", query: "ab", start: 0, end: 3 }, 2);
  assert.equal(session.generation, 2);
  assert.equal(session.pending(), true);
  assert.deepEqual([...session.candidates], []);
});

test("CT06: caret moves without text change keep the session, results and highlight", () => {
  const session = new CompletionSession();
  session.track({ kind: "reference", query: "fi", start: 2, end: 4 }, 5);
  session.applyCandidates(session.generation, [{ label: "一", insertText: "@一" }, { label: "二", insertText: "@二" }]);
  session.moveHighlight(1);
  // 完全相同的 token：只刷新 docRev，不换代次、不清候选、不动高亮。
  session.track({ kind: "reference", query: "fi", start: 2, end: 4 }, 6);
  assert.equal(session.generation, 1);
  assert.equal(session.pending(), false);
  assert.equal(session.highlightIndex, 1);
  assert.equal(session.candidates.length, 2);
  // 同查询不同区间（文本在其他地方变了）：保留候选与高亮，只更新锚点与版本。
  session.track({ kind: "reference", query: "fi", start: 3, end: 5 }, 7);
  assert.equal(session.generation, 1);
  assert.equal(session.pending(), false);
  assert.equal(session.highlightIndex, 1);
  assert.deepEqual(session.hit, { kind: "reference", query: "fi", start: 3, end: 5 });
});

test("CT07: stale results are refused by generation and never disturb the current highlight", () => {
  const session = new CompletionSession();
  session.track({ kind: "reference", query: "s1", start: 0, end: 3 }, 1);
  const stale = session.generation; // s1 查询的代次
  session.track({ kind: "reference", query: "s2", start: 0, end: 3 }, 2);
  const current = session.generation;
  assert.notEqual(stale, current);
  // 迟到的旧结果：applyCandidates 返回 false，候选与高亮都不被触碰。
  assert.equal(session.applyCandidates(stale, [{ label: "旧", insertText: "@旧" }]), false);
  assert.deepEqual([...session.candidates], []);
  assert.equal(session.highlightIndex, -1);
  session.applyCandidates(current, [{ label: "新一", insertText: "@新一" }, { label: "新二", insertText: "@新二" }]);
  session.moveHighlight(1);
  assert.equal(session.highlightIndex, 1);
  // 当前高亮已就绪后，再喂一次旧代次：仍然拒绝，高亮不被重置。
  assert.equal(session.applyCandidates(stale, [{ label: "旧2", insertText: "@旧2" }]), false);
  assert.equal(session.highlightIndex, 1);
  assert.equal(session.candidates.length, 2);
  // 会话关闭后到达的结果同样不采纳。
  session.dismiss();
  assert.equal(session.applyCandidates(current, [{ label: "迟到", insertText: "@迟到" }]), false);
});

test("CT08: accept is refused while pending, with no results, and with no highlight", () => {
  const session = new CompletionSession();
  session.track({ kind: "reference", query: "a", start: 0, end: 2 }, 1);
  // pending：新查询结果未到，Enter 只吞掉不选择。
  assert.equal(session.accept(), null);
  // 结果到达但为空：无高亮可选。
  session.applyCandidates(session.generation, []);
  assert.equal(session.pending(), false);
  assert.equal(session.accept(), null);
  // 关闭会话后不可接受。
  session.track({ kind: "reference", query: "b", start: 0, end: 2 }, 2);
  session.applyCandidates(session.generation, [{ label: "B", insertText: "@B" }]);
  session.dismiss();
  assert.equal(session.accept(), null);
});

test("CT09: accept returns the full pick (span + docRev) and closes the session", () => {
  const session = new CompletionSession();
  const candidate = { label: "final-notes.md", insertText: "@final-notes.md" };
  session.track({ kind: "reference", query: "fi", start: 2, end: 4 }, 9);
  session.applyCandidates(session.generation, [{ label: "field-report.md", insertText: "@field-report.md" }, candidate]);
  session.moveHighlight(1);
  assert.deepEqual(session.highlighted(), candidate);
  const pick = session.accept();
  assert.deepEqual(pick, {
    kind: "reference", query: "fi", start: 2, end: 4,
    candidate, docRev: 9,
  });
  assert.equal(session.isOpen(), false);
  assert.equal(session.highlighted(), null);
});

test("CT10: moveHighlight cycles across ready candidates and ignores empty ones", () => {
  const session = new CompletionSession();
  session.track({ kind: "slash", query: "", start: 0, end: 1 }, 1);
  session.moveHighlight(1);
  assert.equal(session.highlightIndex, -1); // 无候选时不动
  session.applyCandidates(session.generation, [
    { label: "一", insertText: "/一" }, { label: "二", insertText: "/二" }, { label: "三", insertText: "/三" },
  ]);
  assert.equal(session.highlightIndex, 0); // 第一个就绪候选自动高亮
  session.moveHighlight(1);
  assert.equal(session.highlightIndex, 1);
  session.moveHighlight(-1);
  assert.equal(session.highlightIndex, 0);
  session.moveHighlight(-1);
  assert.equal(session.highlightIndex, 2); // 循环到末尾
  assert.deepEqual(session.highlighted(), { label: "三", insertText: "/三" });
  session.setHighlight(0);
  assert.equal(session.highlightIndex, 0);
  session.setHighlight(9);
  assert.equal(session.highlightIndex, 0); // 越界不动
});

test("CT11: applyPickToText replaces the span, appends one trailing space and lands the caret after it", () => {
  assert.deepEqual(applyPickToText("看 @fi 后面", { kind: "reference", query: "fi", start: 2, end: 5 }, "@file.md"), {
    text: "看 @file.md  后面",
    caret: 11,
  });
  assert.deepEqual(applyPickToText("/he", { kind: "slash", query: "he", start: 0, end: 3 }, "/帮助"), {
    text: "/帮助 ",
    caret: 4,
  });
  // 命中在文本末尾：补尾空格仍追加，光标落在新文本之后。
  assert.deepEqual(applyPickToText("前 @fi", { kind: "reference", query: "fi", start: 2, end: 5 }, "@a.md"), {
    text: "前 @a.md ",
    caret: 8,
  });
});

test("CT12: dismissal identity keeps an identical token closed, any change reopens it", () => {
  const session = new CompletionSession();
  session.track({ kind: "reference", query: "fi", start: 0, end: 3 }, 1);
  session.applyCandidates(session.generation, [{ label: "A", insertText: "@A" }]);
  session.dismiss();
  assert.equal(session.isOpen(), false);
  // Esc 后同一 token 不立刻弹回。
  session.track({ kind: "reference", query: "fi", start: 0, end: 3 }, 2);
  assert.equal(session.isOpen(), false);
  // 查询或区间变化：身份不同，重新打开并换代次。
  session.track({ kind: "reference", query: "f", start: 0, end: 2 }, 3);
  assert.equal(session.isOpen(), true);
  assert.equal(session.generation, 2);
  // 选择（accept）同样记录身份：写回后的同 token 不递归重开。
  const second = new CompletionSession();
  second.track({ kind: "slash", query: "he", start: 0, end: 3 }, 1);
  second.applyCandidates(second.generation, [{ label: "/help", insertText: "/帮助" }]);
  second.accept();
  second.track({ kind: "slash", query: "he", start: 0, end: 3 }, 2);
  assert.equal(second.isOpen(), false);
});

test("CT13: track(null) closes without recording dismissal, so returning to the same token reopens", () => {
  const session = new CompletionSession();
  session.track({ kind: "reference", query: "fi", start: 0, end: 3 }, 1);
  session.applyCandidates(session.generation, [{ label: "A", insertText: "@A" }]);
  session.track(null, 2); // 光标移出 token
  assert.equal(session.isOpen(), false);
  session.track({ kind: "reference", query: "fi", start: 0, end: 3 }, 3);
  assert.equal(session.isOpen(), true);
  assert.equal(session.pending(), true); // 重开即新查询，等待当前代次的结果
  assert.equal(session.generation, 2);
});

test("CT14: reopening after a close refetches, and empty results are an accepted non-pending state", () => {
  const session = new CompletionSession();
  session.track({ kind: "slash", query: "h", start: 0, end: 2 }, 1);
  const first = session.generation;
  session.track(null, 2);
  session.track({ kind: "slash", query: "h", start: 0, end: 2 }, 3);
  assert.equal(session.generation, first + 1);
  // 空结果也是「已就绪」：pending 结束，菜单交给 UI 显示无匹配。
  assert.equal(session.applyCandidates(session.generation, []), true);
  assert.equal(session.pending(), false);
  assert.equal(session.candidates.length, 0);
  assert.equal(session.highlightIndex, -1);
});
