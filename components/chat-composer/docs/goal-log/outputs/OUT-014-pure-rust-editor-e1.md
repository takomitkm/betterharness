# OUT-014：E1 换装完成——app-web 集成 taino-edit（taino E2E 18/18 + island 回归 24/24）

- **轮次**：goal 后第十四次输出
- **日期**：2026-11-13

## 本轮做了什么

1. **app-web 集成 taino-edit**（D015）：`?editor=taino` 三编辑器模式并存
   （taino / island fallback / textarea）；Enter 仲裁接 composer-keynav（KD 契约）、
   ImeTracker 根级监听、草稿同步 use_effect、FM01 事务式清空、History undo 绑定。
2. **wasm-bindgen 统一 0.2.130**（app-web pin 0.2.100 → 0.2.130，taino 链要求）。
3. **taino-e2e.mjs**（新门，18 判据）：与 island 24/24 的语义判据一一对应
   （D013 对拍），双实例检查移除（单编辑器应用）。

## 验证证据（校机）

- `e1-e2e3.log`：**taino E2E 18/18**（挂载/中文合成零损坏/失效模式4/KD03/Enter→
  Accepted/FM01 草稿+编辑器双清空/undo/turn 闸门/FIFO/选区保持/零错误）
- `e1-e2e3.log`：**island E2E 24/24 回归**（fallback 模式不受影响）
- `e1-build8.log`：wasm32 构建零错误

## Pure Rust Editor 主线状态

- E0 评估（D014）→ E1 换装（D015）完成；`?editor=taino` 即 Pure Rust 形态
- island（Lexical）保持 fallback；E2 候选：desktop 面板切 taino、性能基线、
  上游 issue 反馈（FM01 选区失联复现齐备）

## goal-log 终态

D001–D015（15 个决定）+ OUT-001–OUT-014（14 次输出）。
