# Goal Log（会话目标执行日志）

> 目标（用户 2026-11-11 设置）：无人 judgment 阻塞即持续推进；**每个决定单独一份 Markdown**；**goal 设置后每次输出单独一份 Markdown**。
> 本目录是这两条纪律的落地位置，随代码一起进 git（每次 push 同步）。

## 结构

```
docs/goal-log/
├── README.md              ← 本索引
├── decisions/             ← D-NNN-*.md：每个决定一份（含 why / alternatives / consequences）
└── outputs/               ← OUT-NNN-*.md：每次输出一份（本轮做了什么、证据、推送 SHA）
```

## 索引

### 决定（decisions）

| 编号 | 文件 | 主题 |
| --- | --- | --- |
| D001 | [D001-goal-log-convention.md](decisions/D001-goal-log-convention.md) | 日志目录选位与记录约定 |
| D002 | [D002-bridge-protocol-design.md](decisions/D002-bridge-protocol-design.md) | Bridge 协议形状：composer-bridge-protocol crate、revision 每发必增、Effect 引用配对、Edit 仅文本 v1 |

### 输出（outputs）

| 编号 | 文件 | 主题 |
| --- | --- | --- |
| OUT-001 | [OUT-001-goal-setup-and-bridge-protocol.md](outputs/OUT-001-goal-setup-and-bridge-protocol.md) | 日志建立 + Phase 2 开工（Bridge 协议 crate） |

## 纪律

- 决定记录在**做出决定的同时**写，不等阶段收尾。
- 输出记录在**每轮回复结束前**写，含推送 SHA 与验证证据；不写感想，只写事实与下一步。
- 主计划书（components/README.md）与实施计划（PRODUCT-LINE-PLAN.md）仍是权威；本目录是执行层的细粒度补充，不重复其内容。
