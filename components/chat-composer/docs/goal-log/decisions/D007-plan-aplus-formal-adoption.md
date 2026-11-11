# D007：Plan A+ 正式采纳为产品线执行计划——PRODUCT-LINE-PLAN.md 替换

- **日期**：2026-11-12
- **状态**：已采纳（用户提出 A+ 正式执行计划全文，本文件记录采纳与关键位移）
- **关联**：D005/D006；PRODUCT-LINE-PLAN.md（已整体替换为 Plan A+）

## 决定

1. **PRODUCT-LINE-PLAN.md 整体替换为 Plan A+ 执行计划**（Dioxus-first 产品 UI + Lexical Editor Island + Rust Core，Phase 0–7）。旧版（React+Lexical 双 Host 计划）保留在 git 历史（4fc2b58），其内容按新计划 §1.2 转为「参考实现与测试基准」。
2. **相对 D006 的关键位移**：
   - D006 说「乙不回滚——产品线仍是乙直到 A+ 过门」；**本计划收紧**：React 线即刻降为参考实现与测试基准，不再作为产品目标继续扩大（新计划 §0.2）。Dioxus 从「实验线」升为「产品 UI 主线起点」。
   - **Tauri 2 从双 Host 中移除**：Desktop = Dioxus Desktop（Wry + 系统 WebView）+ Native Rust Core，不套第二层壳（新计划 §2.3/§九）。
   - **IDB 持久化降为 Phase 5**（计划乙遗留工作）：已提交但未验证的 IDB 适配器 + WasmEngine 接线按 §1.2/§八 单独审计测试，**不得标记为完成**。
   - **首个 Agent 任务 = Phase 0 + Phase 1 PoC**（Lexical Vanilla 化 + Dioxus 挂载 + B 系列关键用例复现 + Go/No-Go），不得一上来迁移整个应用。
3. **新增禁止项**（原文二十条）：不升级 Lexical、不用 Dioxus Signals 重实现 Selection、不引入 Tauri、不在 Snapshot 更新时重建 Editor、不删 React 参考资产等。
4. **D006 的门控语义保持**：Phase 1（Lexical Vanilla PoC）是风险总门；A2 失败预案不变（区分 React Plugin 阻碍 vs Lexical 本身）。

## 与既有事实的对齐

- 新计划 §1.1 状态表与实际一致（BM07 已测绿已提交；IDB 接线已提交未验证；E2E 10/10；B01–B32 = 34 项）。
- D006 已先行记录 A+ 方向采纳；本文记录的是**执行计划正式化**与上述四处位移。
- 未提交的 bridge-wasm `persist_revision()` 导出（3 行委托）保持未提交——未单独验证，随 Phase 5 持久化工作一起验证提交。

## 后果

- 产品线执行顺序改为：Phase 0 审计 → Phase 1 Vanilla PoC（Go/No-Go）→ Phase 2 Dioxus UI → Phase 3 集成 → Phase 4 Core Adapter → Phase 5 IDB → Phase 6 Desktop → Phase 7 回归。
- React+Lexical 参考线（app-react）冻结为对照：不再新增产品功能，测试保留可运行。
- 计划书（components/README.md）第四次修订同步本裁决。
