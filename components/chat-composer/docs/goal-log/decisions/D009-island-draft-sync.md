# D009：island→Rust 台账同步面——document-changed 富化 + 交接后 clear + hand-to-ime DOM 护栏

- **日期**：2026-11-12
- **状态**：已落地（island E2E 24/24 校机全绿）
- **关联**：D008（island controller）；PRODUCT-LINE-PLAN Phase 3；OUT-008

## 决定

1. **document-changed 事件富化（不在控制器里带文本，在挂载 eval 出口取）**：
   控制器的 `EditorEvent` 形状保持 `{ type: "document-changed" }` 不带 payload（KD 面不动）；
   Dioxus 挂载 eval 的 onEvent 出口对 document-changed 附加 `text: getPlainText()` 再 push/派发。
   Rust 侧闭包按事件 type 分流：`submit-request` → do_submit；`document-changed` → `state.edit(Snapshot::text(text))`。
   理由：island 是编辑态唯一事实，Rust Core 草稿是台账面——同步发生在事件出口而非控制器内部，控制器保持业务无关。

2. **交接成功后 Rust 侧 global_eval 清 island**：do_submit 返回 bool，true 时 eval
   `window.__islandController.clear()`。island 的 clear 触发 document-changed("") → 草稿同步空——
   与交接清空草稿是同一次状态变更的 UI 面（FM01）。
   eval 用 `#[wasm_bindgen(js_name = eval)] extern "C"` 直接绑全局函数——web-sys 的 `Window::eval`
   需要额外 feature，不值得为一条调用加 feature。

3. **hand-to-ime 控制器级 preventDefault 护栏**（KD 契约不变，decideEnter 仍返回 preventDefault:false）：
   控制器 Enter 处理器对 `kind === "hand-to-ime"` 额外 `event.preventDefault()`。
   实证链：合成组合中 Lexical 根本不派发 KEY_ENTER_COMMAND（__enterTrace 空数组实锤）——真实 IME 场景
   浏览器默认键被输入法抑制、此护栏是无害冗余；但**组合结束后的 10ms 宽限窗内** Lexical 已恢复派发，
   该 Enter 会落到 hand-to-ime（宽限）分支——没有护栏时浏览器默认键插 `<br>` 污染文本。textarea 路径的
   catch-all `prevent_default` 语义与此对齐。

4. **E2E 组合循环后 setDocument 恢复快照**：合成事件流没有真实输入法抑制默认键，组合循环会留下
   `<br>`/ZWS 残渣；测试在组合循环前存 `getDocument()`、循环后恢复 + `collapseToEnd()`，
   模拟真实 IME 收尾后的编辑器状态（文本完整、光标折叠）。这是测试保真度手段，不是产品行为。

## 关键事实（校机实证，写进后备知识）

- **Lexical 在组合期间不派发 KEY_ENTER_COMMAND**（探针 v6：组合中按 Enter，__enterTrace = []）。
  「组合中 Enter 不提交」的生产保障 = Lexical 自身的组合门 + 真实输入法抑制默认键，不是我们的处理器。
- **合成 composition 循环会让选区非折叠（覆盖全文）**，下一次 compositionstart 按 IME 语义
  「组合替换选区」→ 文本被清成 ZWS。测试侧折叠光标即可避开（探针 v4 T3 实证）。
- **Playwright waitForFunction 的 options 必须是第三参**：`waitForFunction(fn, { timeout })` 的
  对象落在 arg 槽，超时静默变默认 30s（本轮 6-pre 30000ms 之谜的根源）。

## 后果

- island 文本 → Rust 草稿 → handoff → outbox 全链路接通（E2E 4a/4b/4c 实证）。
- turn 闸门 + FIFO 排队派发（B08/FM12）在 island 模式下端到端实证（6a–6e）。
- Rust 面板 textarea 模式与 island 模式共用同一台账/提交函数，行为语义一致。
