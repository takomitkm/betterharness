# OUT-011：Phase 6 完成——Dioxus Desktop 原生构建 + WebView2 CDP 冒烟全通

- **轮次**：goal 后第十一次输出
- **日期**：2026-11-12

## 本轮做了什么

1. **desktop 变体**：dx 约定 feature（default=web / desktop）+ wasm 依赖 target 门控
   + native 时钟/身份 + `BH_DEMO_TRACE` 排空台账落盘 + textarea 自动聚焦（D012）。
2. **破 pre-main 挂死**：15 轮探针定位 = exe 旁缺 `WebView2Loader.dll` → Windows
   loader 静默挂死（进程 alive/有消息泵/main 不执行、双会话同现）。最小二进制隔离
   + notepad 对照 + 复制 DLL 即愈。
3. **CDP 冒烟方案**：WebView2 远程调试端口 + playwright-core connectOverCDP 直驱
   真 WebView（SendKeys 键不进内容区，弃用）。
4. **修两个实现 bug**：autoplay 渲染体副作用无限循环（改 use_effect 一次性）；
   `EnterDecisionInput` Default 的 can_submit=false 让 textarea Enter 恒 noop
   （显式 true，FD06 兜底）。

## 验证证据

- 校机 `phase6-final-run.log`：CDP 冒烟——fill 经真 WebView 键盘 Enter 提交，
  submissions 2 条 = **accepted:desktop cdp msg + queued:second cdp msg（FM11
  turn 闸门）**，draft=second cdp msg\n（textarea 残留已知项，island 无此问题）
- 校机 `phase6-dll-fix.log`：DLL 复制后最小二进制 "main entered"
- 校机 `phase6-regression.log`：can_submit 修复后 island E2E **24/24** 回归
- 校机 `phase6-desktop-build.log`：desktop 原生构建零错误（1m25s）

## 排查方法收获

- 「进程 alive 但 main 第一行不执行」→ 先查静态导入 DLL 缺失（loader pre-main 挂死），
  再查会话上下文；最小复现二进制 + 对照组（notepad）是判别利器。
- 校机冒烟脚本一律 Windows 原生 .cmd 承载（schtasks /IT /TR 的 MSYS 路径转换
  + bash PATH 抢 timeout/find 的坑全部绕开）。

## 下一步

Phase 7：全量回归收口（三线语义对拍清单）+ 收尾清理（island __enterTrace 转正或移除）。
