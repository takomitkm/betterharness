# OUT-012：Phase 7 收口——三线全量回归全绿，A+ 计划 Phase 0–7 闭环

- **轮次**：goal 后第十二次输出
- **日期**：2026-11-12

## 本轮做了什么

1. **探针清理**：`__enterTrace` 从 create-controller.ts 移除（hand-to-ime DOM 护栏
   保留，史实入 D009）；probe-phase3.mjs / island-e2e.mjs 注释同步。清理后 island
   测试复跑全绿 = 行为零变化。
2. **三线全量回归**（校机）：
   - 线 1：workspace **111/0** + island Node **8/8**（KD 契约）+ island 浏览器 **14/14**
     + island E2E **24/24**
   - 线 2：demo2-wasm **12/12×2**（typecheck OK，含 reload IDB 持久化断言）
   - 线 3：desktop CDP 冒烟——真 WebView fill/Enter → **accepted + queued（FM11）**
3. **D013 三线语义对拍清单**：三 Host × 六语义面的判据矩阵 + 分层守卫原则
   （E2E 验接线、内核语义由 Rust 原生测试守卫）。

## 全量证据（校机日志）

- `phase7-line1.log`：RUST 111/0 + island E2E 24/24
- `phase7-island-tests.log`：island Node 8/8
- `phase7-island-browser.log`：island 浏览器 14/14
- `phase7-line23.log`：demo2-wasm 12/12×2 + desktop trace accepted/queued

## A+ 计划终态

| Phase | 状态 | 主证据 |
| --- | --- | --- |
| 0 迁移审计 | ✓ | phase0 报告 |
| 1 Lexical Island PoC | ✓ | 浏览器 14/14 + Node 8/8 |
| 2 Dioxus rsx 化 | ✓ | phase2-gonogo（Go） |
| 3 Dioxus+Island 集成 | ✓ | island E2E 24/24（OUT-008） |
| 4 Rust Core 直调 | ✓ | composer-host 10/10 + 回归（OUT-010） |
| 5 IDB 持久化 | ✓ | demo2-wasm 12/12×2（OUT-009） |
| 6 Desktop | ✓ | CDP 冒烟 accepted/queued（OUT-011） |
| 7 跨 Host 回归 | ✓ | D013 对拍清单 + 本轮三线全绿 |

goal-log 终态：D001–D013（13 个决定）+ OUT-001–OUT-012（12 次输出）。

## 遗留（Future，非 Phase 7 范围）

- Pure Rust Editor（计划 §Future：准入条件后替换 Lexical）
- desktop textarea 的 prevent_default 怪癖（D012 已知项，island 无影响）
- island 资产在 desktop WebView 的装载（现走 textarea 面，island 主产品面在 web）
