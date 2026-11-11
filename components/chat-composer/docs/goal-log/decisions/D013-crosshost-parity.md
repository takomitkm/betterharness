# D013：三线跨 Host 语义对拍清单（Phase 7 收口基线）

- **日期**：2026-11-12
- **状态**：已落地（三线全绿，探针清理完成）
- **关联**：D009–D012；PRODUCT-LINE-PLAN §十四（统一测试体系）/ Phase 7；OUT-012

## 三线 Host 与验证面

| Host | 内核路径 | 验证面 | 结果 |
| --- | --- | --- | --- |
| Dioxus web + Lexical Island | composer-host 直调 Runtime（强类型） | island E2E 24/24 | ✓ |
| React + WasmEngine（JS 桥） | BM05 DTO JSON + Effect ref ack | demo2-wasm E2E 12/12×2 | ✓ |
| Dioxus Desktop（原生 WebView2） | composer-host 直调 Runtime（native 时钟） | CDP 冒烟（fill/Enter 真键盘链） | ✓ |

## 同协议语义对拍清单（三线同判据）

| 语义 | island E2E | demo2-wasm | desktop CDP |
| --- | --- | --- | --- |
| Enter 提交 → Outbox Accepted | 4a ✓ | 端到端 ✓ | accepted ✓ |
| 交接与后继空草稿（FM01） | 4b ✓ | 交接后草稿清空 ✓ | —（desktop 冒烟未断言 draft） |
| turn 闸门：忙时排队（FM11） | 6a/6c ✓ | 忙时 C 排队 ✓ | queued ✓ |
| end_turn FIFO 派发（FM12） | 6d/6e ✓ | end-turn 后 C 派发 ✓ | —（单 turn 冒烟） |
| 组合中 Enter 不提交（失效模式 4） | 3a ✓ | —（React 线走 B 系列 Rust 测试） | — |
| 持久化恢复（FM09） | —（web 内存面） | reload 后 Outbox 恢复 ✓ | —（BH_DEMO_TRACE 面可扩展） |
| 回执身份（FM15） | —（回环恒配对） | — | —（回环恒配对） |

空白格 = 该线 demo 形态未覆盖该面，由其内核层原生测试守卫：composer-host 10/10
（FM01/05/11/12/14/18/24/25/FD06）、composer-core 101 项、BM07 CAS 7/7。
**分层原则：三线 E2E 验证接线，内核语义由 Rust 原生测试守卫，不追求三线逐一重复。**

## 探针清理（本轮）

- `create-controller.ts` 移除 `__enterTrace` 探针（保留 hand-to-ime DOM 护栏；
  组合中不派发命令的史实移入 D009 注释）；island Node 8/8 + 浏览器 14/14 复跑全绿
  ——行为零变化实证。
- `probe-phase3.mjs` 去引用（保留合成组合 DOM dump 用途）；island-e2e 注释改指 D009。

## 后果

- A+ 计划 Phase 0–7 全部闭环；DoD「跨 Host 行为一致」以本清单为基准线，
  后续改动以三线回归（phase7-line1/line23 脚本）守住。
- desktop 腿的可持续验收 = CDP 冒烟脚本（smoke-cdp.cmd + cdp-drive.mjs），
  部署前提：WebView2Loader.dll 在 exe 旁（D012）。
