# OUT-009：Phase 5 IDB 持久化——demo2-wasm E2E 12/12×2 校机全绿（含 reload 断言）

- **轮次**：goal 后第九次输出
- **日期**：2026-11-12

## 本轮做了什么

1. **定位并修复「CAS 挂起」根因**（D010）：wasm-bindgen glue 方法名是 snake_case
   （`persist_revision`），WasmEngine 写的 camelCase `persistRevision()` 抛 TypeError，
   effects 泵死在第一个 persist effect——deliver 永不执行、E2E 卡 queued。一行修复。
2. **桥 wasm 产物对齐**：校机 `cargo clean --release --target wasm32-unknown-unknown
   -p composer-bridge-wasm` 定点重建 → pkg → vendor（含 persist_revision 导出的 glue）。
3. **E2E 验证**（phase5-final.log）：demo2-wasm 12/12×2 双轮全绿，含此前一直挂起的
   「reload 后 Outbox 恢复」「reload 后文本正确」两条 IDB 持久化断言。

## 验证证据

- 校机 `phase5-final.log`：12/12 × 2 轮全绿
- 链路：输入 → WasmEngine → Rust WASM Core（handoff/queue/turn）→ 回环 fixture →
  Outbox Accepted → Effect::Persist → persist.ts IDB cas → reload → FM09 恢复
- typecheck OK + build:demo OK

## 排查方法收获

- 三连假信号（grep 大小写 / name section ≠ export / clean 不带 --target）逐个击破，
  终判工具 = `WebAssembly.Module.exports()`（运行时导出表，不受符号名干扰）。

## 下一步

- Phase 4：Rust Core Adapter 直调（无 JSON 桥）
- Phase 6/7：Dioxus Desktop + 全量回归
- 收尾清理：island 的 __enterTrace 探针、probe-phase3.mjs 转正或移除
