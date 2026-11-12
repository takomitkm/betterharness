# OUT-018：E3b 附件/图文调位完成——附件 E2E 12/12 + 三线回归全绿

- **轮次**：goal 后第十八次输出
- **日期**：2026-11-13

## 本轮做了什么

1. **附件接线**（D019）：intake 守卫（intake_files）+ rail UI（卡片/移除/←→）+
   reorder 重排（compute/apply_move_span）+ Snapshot.attachment_ids 全链 +
   file input（FileData 异步读 meta.bytes）。
2. **Edit-keeps-ids 语义**：文本 Edit 统一保留台账现 ids（协程侧），附件面独立
   于文本——修掉「打字覆盖附件面」的覆盖 bug。
3. **E2E 判据**（taino-attach-e2e.mjs，12 项）：接受→卡片+ids/追加/前移重排/
   快照同步/移除/提交载荷带 ids/附件-only 可提交/超限拒绝提示/零错误。

## 验证证据（校机）

- `e3b-run3.log`：**附件 E2E 12/12**
- `e3b-run3.log`：**taino 18/18 + 菜单 14/14 + island 24/24 回归**
- `e3b-build17.log`：wasm32 构建零错误

## 五交互 Rust 线终态

| 交互 | 状态 |
| --- | --- |
| 可靠提交 | ✓ Phase 4/5 |
| 中文 IME | ✓ island + taino 双线 |
| 候选菜单 | ✓ E3a（14/14） |
| 逐条取回/重试 | ✓ Runtime 事件 |
| **附件/图文调位** | ✓ **E3b（12/12）** |

goal-log：D001–D019 + OUT-001–OUT-018。

## 下一步

- CI 工作流（workflow_dispatch 手动跑：workspace 测试 + wasm 构建 + 四套 E2E）
- 本地 main 与远端对齐（443 恢复后或继续校机同步流）
