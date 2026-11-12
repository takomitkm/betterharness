# OUT-017：E3a 候选菜单完成——taino 线 14/14 + 双回归全绿

- **轮次**：goal 后第十七次输出
- **日期**：2026-11-13

## 本轮做了什么

1. **候选菜单接入 taino 线**（D018）：AppEvent 分层（Runtime|Menu）、会话进协程、
   keymap 菜单键（Up/Down/Enter/Esc，菜单开时吞键）、aria listbox UI、
   detect_trigger→demo_provider→accept 写回全链。
2. **taino 内建键补齐**：structural 键纪律（Backspace/Delete 无论命中一律
   preventDefault）——补 delete_backward/delete_forward/split_block/Shift-Enter。
3. **main 收口确认**：feat 52 提交在 origin/main（cdb73b3）；API ref PATCH 不可靠
   定案（假成功+副本旧值），校机 git 直推为断连期正道。

## 验证证据（校机）

- `e3a-run-final.log`：**菜单 E2E 14/14**（@ 触发/高亮/过滤缩窄/Enter 接受不提交/
  写回补空格/Esc/slash/无菜单恢复提交/菜单 Enter 不提交/零错误）
- `e3a-run-final.log`：**taino 18/18 + island 24/24 回归**
- `e3a-build18.log`：wasm32 构建零错误

## 主线状态

- 五交互 Rust 线：可靠提交 ✓ / IME ✓ / **候选菜单 ✓（本轮）** / 取回重试 ✓ /
  附件图文调位（E3b 待做）
- goal-log：D001–D018 + OUT-001–OUT-017

## 下一步

- E3b：附件/图文调位（AttachmentCards 的 Rust 线对齐）
- CI 工作流（workflow_dispatch 手动跑）
