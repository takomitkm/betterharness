# D016：E2——性能基线（双模对等）+ desktop 边界修正 + 上游 issue 素材

- **日期**：2026-11-13
- **状态**：已落地（性能基线完成；desktop 修正记录；issue 草稿待批）
- **关联**：D013（对拍清单「性能合格」项）；D015；OUT-015

## 决定

1. **性能基线（D013「性能合格」项）= 双模对等**（perf-e2e.mjs，CDP 墙钟含固定
   CDP 开销，差值即应用成本差）：

   | 指标 | taino | island (Lexical) |
   | --- | --- | --- |
   | 一次性插入 1200 字符（全链） | 9ms | 9ms |
   | 逐键 138（CDP 每键 1-2ms 打底） | 131ms（~0.95ms/键） | 137ms（~0.99ms/键） |
   | 提交周期（Enter → Accepted） | 5ms | 6ms |
   | 长文档 50k 一次性插入 | 17ms | 16ms |

   两模式差值全部在 CDP 噪声内——Pure Rust Editor 性能与 Lexical 对等，D013
   「性能合格」达成。逐键指标贴着 CDP 底噪，应用侧成本不可分辨。

2. **desktop 边界修正**（推翻 OUT-014 的乐观估计）：taino-edit-dom 的 DOM 桥是
   wasm-bindgen 绑定——desktop 原生运行时调用即 trap，**desktop 切 taino 需要
   taino-edit 出 dioxus-desktop 适配器**（DOM 操作经 dioxus document API 代理），
   属上游规模工作。desktop 保持 textarea 面（Phase 6 冒烟不变）。web 是 taino 的
   完整产品形态。

3. **FM01 选区失联已修**：事务式清空（tr().transform().replace + apply）替代
   重建 EditorState——保历史与选区映射，undo 栈保留（清空可撤销，反超 island）。

4. **上游 issue 素材齐备**（docs/upstream/taino-edit-selection-desync.md）：
   选区失联复现 + 事务式 workaround + 判据矩阵；查重干净（repo 内 selection
   0 hits，PR #19 主题不同已引用）；**发帖待用户批准**（对上游写操作 = 新目标）。

## 后果

- D013 对拍清单全部项达成（三线行为一致 + 性能合格——web 双模对等 +
  desktop textarea 冒烟）
- taino 主线：web 产品形态完整可用；desktop 化 = 上游依赖，已记录边界
- 上游 issue 是社区回馈兼关系建立的第一步（发帖后跟踪作者响应）
