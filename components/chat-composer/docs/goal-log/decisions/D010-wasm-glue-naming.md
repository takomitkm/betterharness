# D010：wasm-bindgen glue 命名是 snake_case——CAS 挂起的根因与排查教训

- **日期**：2026-11-12
- **状态**：已落地（demo2-wasm E2E 12/12 双轮校机全绿，含 reload 持久化断言）
- **关联**：D002/D003（bridge 协议）；BM07（persist_revision CAS）；OUT-009

## 决定

1. **TS 侧调用 wasm-bindgen 导出必须用 Rust 原名（snake_case）**：glue 不做 camelCase
   转换——`persist_revision` 导出在 glue 里就叫 `persist_revision()`。WasmEngine 之前写的
   `bridge.persistRevision()` 是 undefined → 调用抛 TypeError → effects 泵死在第一个
   persist effect 上 → deliver 永不执行 → E2E 卡 queued/admitting。已改回 snake_case。
   （`snapshot/dispatch/ack` 三个单词的方法两边同形，掩盖了这一命名规律——教训。）

2. **排查教训（三连假信号烧了六轮）**：
   - `grep -c persistRevision glue.js` 恒 0——检查字符串大小写错了，glue 里一直是
     snake_case，前几轮「GLUE-LACKS」全是假信号；
   - raw wasm 的 `grep -a persist_revision` 命中的可能是 name section（调试符号），
     不代表 export；判定要用 `WebAssembly.Module.exports()`；
   - `cargo clean -p` 不带 `--target wasm32-unknown-unknown` 清的是 host 侧——wasm32
     陈旧产物不动；`touch` 后 0.04s "Finished" = 没真编。
   - tar 解压保留归档内 mtime → 跨机同步后 cargo 可能误判 fresh——定点重建用
     `cargo clean --release --target wasm32-unknown-unknown -p <pkg>`。

3. **Phase 5 持久化链路定案**（BM07 实测语义）：
   Rust `Effect::Persist` → WasmEngine `executeEffect` 取 `bridge.persist_revision()`
   为 CAS expected → persist 适配器 `cas(state, expected)` 写 IndexedDB → ack(Persisted)
   后 Rust `persist_revision += 1`。reload 时 `new(scope, Some(state_json))` 恢复（FM09）。
   适配器用独立数据库 `composer-bridge-state`（与 TS 引擎的库不同 schema，避免冲突）。

## 后果

- demo2-wasm E2E 12/12×2 全绿：首要链路/hold/迟到接纳不擦草稿/忙时排队/end-turn 派发/
  reload 恢复 outbox+文本/零未捕获错误。
- Phase 3（Dioxus island）与 Phase 5（React wasm+IDB）两条 host 线都已实证可靠提交语义。
- 后续 Rust 侧加导出时：先在 glue 上 `grep snake_case 原名`，别用 camelCase 猜。
