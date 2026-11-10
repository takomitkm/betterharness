# D003：Web WASM Host 桥面 = JSON 单一序列化路径

- **日期**：2026-11-11
- **状态**：已采纳并落地（composer-bridge-wasm 构建 + Node 冒烟 18/18）
- **关联**：D002；PRODUCT-LINE-PLAN Phase 3；跨 Host 对拍（§8.1）

## 决定

1. **`composer-bridge-wasm` crate**（cdylib+rlib）导出 `WasmBridge`：`new(state_json?) / snapshot() / dispatch(event_json) / ack(ref_id: u32, outcome_json) / pending_count()`——**全部 JSON 字符串进出**。备选「wasm-bindgen struct 展开（serde_wasm_bindgen）」被否：两条序列化路径（WASM 展开 vs Tauri IPC JSON）会让 Web/Desktop 协议漂移；JSON 单一路径让跨 Host 对拍退化为字符串比对（canonical JSON）。
2. **Clock/IdGen 宿主注入落地**：Web = `js_sys::Date::now()` + 计数器/`Math.random` 前缀。Date.now 回拨风险已知（D002 观察项），改进路径 = performance.now() 基准，不阻塞当前门。
3. **ack 参数 u32**：wasm-bindgen 把 u64 导出为 JS BigInt（调用侧必须 BigInt），引用计数规模用 u32 即可（JS number 直接可用）；BridgeCore 内部仍 u64，导出层转换。
4. **持久化边界**：ScopeState JSON 由 JS 侧 IndexedDB 存取（Web）/Tauri 后端文件（Desktop）——构造传 `Some(state_json)` 恢复（FM09 sending→unknown 冒烟已验）；Persist Effect 的回执 = CAS 写入结果 ack 回填。Core 不感知存储介质。
5. **Edit 不开 admitting 窗口**：冒烟第一版断言 Edit 后 admitting=true 是**错的**——TS core.ts 的 edit 从不设 admitting（只有 submit/restore），Rust 对齐正确。测试改断言为 false。教训：移植语义的对拍以 archive 源码为准，不以记忆为准。

## 后果

- 首要交付链路的服务器侧已真实跑通：**Edit→Persist→Submit→Persist→Deliver(accepted)→Persist→Outbox Accepted→轮次激活**，全程真实 Rust WASM Core（Node 里以 wasm-bindgen web target 加载，非 mock）。
- 下一步（UI 接线）：`WasmEngine` 适配 archive 的 ComposerEngine 接口（getSnapshot/edit/submit/subscribe），LexicalEditor/ChatComposer 调用点收口——Lexical onChange → dispatch(edit)，Enter → submit。
