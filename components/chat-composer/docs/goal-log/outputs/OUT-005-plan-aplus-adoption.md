# OUT-005：Plan A+ 正式执行计划收编——PRODUCT-LINE-PLAN.md 替换 + D007

- **轮次**：goal 后第五次输出
- **日期**：2026-11-12

## 本轮做了什么

1. **PRODUCT-LINE-PLAN.md 整体替换**为 Plan A+ 执行计划（Dioxus-first 产品 UI + Lexical Editor Island + Rust Core，Phase 0–7）。旧版（React+Lexical 双 Host）在 git 历史 4fc2b58 可查；React 线转参考实现与测试基准。编者注记录决策链（D005→D006→本文）。
2. **D007 决策记录**：正式采纳 + 相对 D006 的四处位移（React 线即刻降参考、Tauri 移除、IDB 降 Phase 5、首任务=Phase 0+1 PoC）+ 新增二十条禁止项。
3. **计划书第四次修订待提交**：§9/§10 按 A+ 更新。
4. **工作树审计**（新计划 §1.2 要求）：BM07/persist_revision 已提交且测试绿（e4d0768）；IDB 适配器 + WasmEngine 接线已提交未验证（Phase 5 审计对象）；bridge-wasm persist_revision 导出未提交（未验证，保持工作树）。

## 验证证据

- PRODUCT-LINE-PLAN.md 替换后全文在库；D007/OUT-005 落盘
- git 状态核实：IDB WIP 已入库（e4d0768），bridge-wasm 导出未提交

## 推送

- 本轮提交：计划替换 + 计划书第四次修订 + D007/OUT-005 + goal-log 索引更新

## 下一步

按新计划首个 Agent 任务执行：**Phase 0（迁移审计+基线冻结+工作树快照报告）→ Phase 1（Lexical Vanilla 化 PoC + Dioxus 挂载 + B12 中文 IME 门）**。不得一上来迁移整个应用。
