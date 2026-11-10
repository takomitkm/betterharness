# D001：Goal 日志目录选位与记录约定

- **日期**：2026-11-11
- **状态**：已采纳
- **关联**：用户 goal 设置（每决定一份 Markdown / 每输出一份 Markdown）

## 决定

日志落在 `components/chat-composer/docs/goal-log/{decisions,outputs}/`，编号 D-NNN / OUT-NNN，随代码进 git 并随每次 push 同步。

## 备选方案

| 方案 | 否/取 | 理由 |
| --- | --- | --- |
| 仓库根 `.goal-log/` | 否 | goal 执行全部发生在 chat-composer 工程，放根目录割裂上下文 |
| 单一大文件追加 | 否 | 违反用户"单独一份"的字面要求；diff 噪声大 |
| 本地不进 git | 否 | 日志必须与代码提交一一对应（OUT 里引用 push SHA），进 git 才可核对 |
| components/chat-composer/docs/goal-log/ | **取** | 与已有 docs/architecture、docs/testing 同层；随工程走 |

## 约定细节

1. D 文件在决定做出时写；OUT 文件在每轮输出结束前写。
2. OUT 只记事实：做了什么、验证证据（测试数字/命令）、推送 SHA、下一步。不记过程感想。
3. 不复制计划书/实施计划内容，只引用（它们是权威）。
4. 索引表在 README.md 维护，新文件必须登记。
