# taino-edit 上游 issue 草稿（待用户批准后发）

**标题**: Selection desync after replacing EditorState via signal — subsequent typing inserts characters in reverse order

**仓库**: juanma-dev/taino-edit（Dioxus adapter, taino-edit-dioxus 0.7.0）

---

## Summary

When a host replaces the editor's `Signal<EditorState>` with a freshly constructed
`EditorState::new(doc, schema)` (e.g. a chat composer clearing the draft after a
successful submit), subsequent typing into the (now empty) editor inserts
characters in **reverse order** — the DOM text ends up as the reverse of what was
typed. Using a transaction-based clear (`state.tr().transform().replace(...)` +
`apply`) instead keeps selection mapping intact and typing works correctly.

## Environment

- taino-edit-dioxus 0.7.0, taino-edit-core/dom 0.7.0 (crates.io)
- Dioxus 0.7.10, wasm-bindgen 0.2.130, wasm32-unknown-unknown
- headless Chromium / Edge (Playwright), Windows host

## Reproduction

1. Mount `<TainoEditor state={signal} keymap .../>` where the signal holds a
   doc containing one empty paragraph (schema: doc "block+", text "inline",
   Paragraph extension).
2. Type text (works correctly).
3. Host-side: replace the signal with a **fresh** state:
   ```rust
   let para = schema.node("paragraph", Default::default(), vec![], vec![]).unwrap();
   let doc = schema.node("doc", Default::default(), vec![para], vec![]).unwrap();
   editor.set(EditorState::new(doc, schema)); // FM01-style clear
   ```
4. Focus the editor and type `selection test`.

**Observed**: DOM text becomes `tset noitceles` (reverse of the input) — each
keystroke appears to be inserted before the previous one, i.e. the DOM caret and
the model selection disagree after the state swap.

**Expected**: `selection test` appended at the caret.

## Workaround that works

Replace the clear with a **transaction** on the same state (keeps history and
selection mapping):

```rust
let current = editor.peek().clone();
let schema = current.schema().clone();
let empty_para = schema.node("paragraph", Default::default(), vec![], vec![]).unwrap();
let size: usize = (0..current.doc().child_count())
    .map(|i| current.doc().child(i).node_size())
    .sum();
let mut tx = current.tr();
tx.transform().replace(
    0, size,
    Slice::new(Fragment::from_nodes(vec![empty_para]), 0, 0),
    &schema,
).expect("clear replace");
editor.set(current.apply(tx));
```

With the transaction clear, typing behaves correctly (18-check browser suite
passes; with the fresh-state clear, 2 checks fail with the reversed text).

## Suspected area

The adapter's state-change effect patches the DOM and re-syncs the selection
after a signal swap — a fresh `EditorState` (new doc node identity, default
selection) may leave the DOM caret at the pre-swap position while the model
selection resets, so subsequent DOM-typing → Transform steps interleave
backwards. Possibly related to #19 (`read_dom_changes`/`try_patch` typing
detection), but distinct: #19 is text typed *next to* existing content; this is
selection desync after *state replacement*.

## Test evidence

Browser suite (Playwright, msedge): 18-check composer E2E — mount, IME
composition, Enter arbitration, FM01 clear, undo, turn gate, FIFO dispatch —
16/18 with the fresh-state clear (5b/7a fail with reversed text), 18/18 with
the transaction clear. Happy to share the suite if useful.

---

## 发帖前检查清单（AGENTS.md 规矩）

- [x] 查重：repo issues 搜 selection = 0 hits；#19 主题不同（已引用）
- [ ] 用户批准发帖（对上游仓库写操作 = 新目标，需明确同意）
- [ ] 发帖账号：gh:github.com:takomitkm 令牌（与 push 同源，需用户确认沿用）
