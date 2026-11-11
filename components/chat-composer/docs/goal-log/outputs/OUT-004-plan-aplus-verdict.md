# OUT-004：Plan A+ 细则对比裁决（D006）+ Phase 2 后半 WIP

- **轮次**：goal 后第四次输出
- **日期**：2026-11-12

## 本轮做了什么

1. **D006 三版对比裁决**：细则表逐条核对后裁决——**产品方向采纳 Plan A+（Dioxus 主 UI + Vanilla Lexical 内核 + Rust Core），门控渐进**；乙降为已交付基准线 + 对照组；甲的纯 Rust 编辑器降为 editor-rs 实验。A+ 可行性在我方 762 行 LexicalEditor.tsx 上核实：React 耦合面 = 7 个包装导入，13 处自定义注册全是 vanilla API，`decorate()` 返回 null 无 React 门户——迁移是适配不是重写。
2. **Phase 2 后半 WIP**（未测完不提交）：
   - composer-bridge-protocol：BridgeCore `persist_revision` CAS 计数器（BM07 测试绿 7/7）——Persist 的 expected 依据，ok 递增/失败保持
   - composer-bridge-wasm：`persist_revision()` 导出
   - app-react：`src/hosts/web/persist.ts`（IDB CAS 适配器）+ WasmEngine 接线（initialize 先 load、persist effect 走真 CAS）——**未完成 E2E 验证，留在工作树**
3. 途中修复：BM07 断言修正（冲突确认也发射快照，revision 每发必增——D002 语义）+ 尾部括号结构重建。

## 验证证据

- composer-bridge-protocol：**7/7 绿**（bm07-6.log）
- 其余门禁沿用 main=b386cae 状态（100/100）

## 推送

- D006/OUT-004 + BridgeCore persist_revision（已测部分）：见 push 后 ls-remote
- WIP 未提交（IDB 适配 + WasmEngine 接线未过 E2E）

## 下一步

1. 完成 IDB 接线验证：E2E 加「reload 后 outbox 恢复」断言 → 提交。
2. **A2 PoC 启动（风险总门）**：Lexical Vanilla 化——七项 React 包装换装（PlainTextPlugin→registerPlainText 等）+ B12 中文 IME 复现作为门。
3. A1/A3 视 A2 结果排期。
