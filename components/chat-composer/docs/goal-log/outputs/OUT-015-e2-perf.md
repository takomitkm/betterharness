# OUT-015：E2 完成——性能基线双模对等 + desktop 边界修正 + 上游 issue 素材

- **轮次**：goal 后第十五次输出
- **日期**：2026-11-13

## 本轮做了什么

1. **性能基线**（perf-e2e.mjs）：taino vs island 双模对测（每指标独立加载新页）——
   四项指标全对等（差值在 CDP 噪声内），D013「性能合格」达成。
2. **desktop 边界修正**：taino-edit-dom 的 DOM 桥是 wasm-bindgen 绑定，原生运行时
   不可用——desktop 切 taino 需上游 dioxus-desktop 适配器；desktop 保持 textarea
   （Phase 6 冒烟不变）。
3. **上游 issue 素材**：FM01 选区失联（重建 EditorState → 打字反转）完整复现 +
   事务式 workaround + 判据矩阵，查重干净，草稿落 docs/upstream/，**发帖待批**。

## 验证证据（校机）

- `perf-run2.log`：双模四指标（one-shot 9/9ms、逐键 131/137ms、提交 5/6ms、
  50k 长文档 17/16ms）
- `e1-e2e3.log`：taino E2E 18/18 + island 24/24（回归基线）

## Pure Rust Editor 主线终态

| 阶段 | 状态 |
| --- | --- |
| E0 评估 | ✓ 判据 9/9（D014） |
| E1 换装 | ✓ taino E2E 18/18 + island 24/24（D015） |
| E2 性能 | ✓ 双模对等（D016） |
| desktop 化 | 上游依赖（dioxus-desktop 适配器），已记录边界 |

goal-log 累计：D001–D016 + OUT-001–OUT-015。
