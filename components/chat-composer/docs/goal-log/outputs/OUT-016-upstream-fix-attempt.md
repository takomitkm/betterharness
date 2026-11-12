# OUT-016：上游修复尝试——根因实锤 + fork 三分支 + PR #24

- **轮次**：goal 后第十六次输出
- **日期**：2026-11-13

## 本轮做了什么

1. **根因单变量实锤**：app-web FM01 临时切回重建 EditorState 路径——
   caret(0) → 16/18（打字反转）；+ core 一行修复（`initial_text_caret`）→
   **同路径 18/18**。A 案（默认光标进首个文本块）确认为根因修复。
2. **fork takomitkm/taino-edit** + 三分支推送：
   - `fix/initial-selection-textblock`（A 主修）：core 一行 + documented helper
   - `fix/dom-selection-reanchor`（B 候选）：EditorView::update 末尾重锚
   - `fix/adapter-selection-snap`（C 候选）：adapter 边界 caret snap
3. **PR #24**（juanma-dev/taino-edit）：根因链 + 复现 + 变通 + B/C 引用 + #19 关联。
4. app-web 回滚实验态至 D015 发布版（事务式清空，无本地 patch 依赖）。

## 链接

- PR：https://github.com/juanma-dev/taino-edit/pull/24
- fork：https://github.com/takomitkm/taino-edit
- 分支：fix/initial-selection-textblock（A）/ fix/dom-selection-reanchor（B）/
  fix/adapter-selection-snap（C）

## 验证证据（校机）

- `taino-fixA-verify2.log`：fixA 后同路径 18/18（注：该轮 app-web 未含 patch，
  18/18 为事务清空版——假验证，已由 Cargo.lock source 行判据纠正）
- `taino-exp1.log`：**决定性实验**——重建路径 + fixA core → 18/18（修复前 16/18）
- `taino-fixA-verify3.log`：patch 真正生效（lock 无 registry source）+ 事务清空 18/18

## 遗留

- 等 taino-edit 作者 review PR #24；B/C 若被选中需按其意见深化
- betterharness 侧无阻塞：事务式清空独立工作
