# OUT-008：Phase 3 集成 E2E——Dioxus + Lexical Island 24/24 校机全绿

- **轮次**：goal 后第八次输出
- **日期**：2026-11-12

## 本轮做了什么

1. **打通 island→Rust 台账同步面**（D009）：document-changed 出口富化文本、Rust 闭包
   分流编辑/提交事件、交接成功后 eval 清 island。此前 Rust Core 草稿永远是空的，
   handoff 静默失败——这是 Enter 提交 E2E 长期超时的根因。
2. **修复三个实现面问题**：
   - `Window::eval` 缺 web-sys feature → 改绑全局 eval extern；
   - `use_effect` 闭包 clone 缺 `mut`（document-changed 分支要 set）；
   - `LEDGER_MIRROR` 从未被写（app() 渲染时补写）+ `__composerView` shim 接通
     （INDEX_HTML init 后从 wasm 导出取 composer_view_json）。
3. **控制器加 hand-to-ime preventDefault 护栏**（KD 契约不动）+ Enter 追踪探针（__enterTrace）。
4. **E2E 保真度修正**：组合循环后 setDocument 恢复快照 + 光标折叠；step 6 重写为
   turn 闸门 + 两条排队 + 两次 end-turn FIFO 派发；waitForFunction options 槽位修正。

## 验证证据

- 校机 `phase3-full-run-7.log`：**RUST 101/0 + island E2E 24/24 全绿**
- E2E 覆盖：挂载/Dioxus 渲染/中文合成输入/组合中 Enter 不提交/组合后文本完整/
  Enter 提交→Outbox Accepted→草稿清空→文本正确/撤销栈/turn 闸门排队/FIFO 派发/
  选区保持/双 island 并行/零未捕获错误
- 探针链（probe-phase3 v1–v6）留证：synthetic composition 逐级 dump、选区状态、
  __enterTrace、合成 submit-request 直打 Rust 监听器

## 排查方法收获

- 逐环探针（shim→文本→草稿同步→合成事件→outbox）比盲改快得多——每轮一轮 SSH 定位一环。
- build 脚本没 `set -e` 导致 cargo 失败后 wasm-bindgen 照样跑陈旧 wasm——加了
  `pipefail + 显式 FAILED 退出`，这类"绿日志红产物"不再出现。

## 下一步

- Phase 5：IDB 持久化独立验证（persist.ts 适配器 + demo2-wasm reload 断言）
- Phase 4：Rust Core Adapter 直调（无 JSON 桥）
- 收尾时移除 __enterTrace 探针（或转为正式诊断开关）
