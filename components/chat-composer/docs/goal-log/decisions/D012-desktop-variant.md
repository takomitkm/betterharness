# D012：Dioxus Desktop 变体——WebView2Loader.dll pre-main 挂死与 CDP 冒烟方案

- **日期**：2026-11-12
- **状态**：已落地（desktop 原生构建零错误 + CDP 冒烟 Enter 链全通 + island E2E 24/24 回归）
- **关联**：D011（composer-host）；PRODUCT-LINE-PLAN Phase 6；OUT-011

## 决定

1. **平台 feature 走 dx 约定**：`[features] default=["web"]`、`web=["dioxus/web"]`、
   `desktop=["dioxus/desktop"]`。wasm 构建 = default（wasm32 target）；desktop 构建 =
   `cargo build --release --no-default-features --features desktop`。wasm 专有依赖
   （wasm-bindgen/web-sys/js-sys）移入 `[target.'cfg(target_arch = "wasm32")'.dependencies]`，
   desktop 原生构建不拉 wasm 栈；`#[cfg(target_arch = "wasm32")]` 门控 island 挂载/
   composer_view_json/global_eval 等 web 面。ComposerHost/clock/ids 复用（native 时钟
   = SystemTime），Runtime 事件循环同构（§7.5）。

2. **WebView2Loader.dll 必须在 exe 旁边**（本轮最大坑）：desktop 构建产物若缺
   `WebView2Loader.dll`（webview2-com-sys x64 目录自带），Windows loader 解析缺失
   DLL 时 **pre-main 静默挂死**——进程 alive、有消息泵、4 线程，但 main 第一行
   （fs::write 固定路径 marker）永不执行，零 stderr，SSH 会话与 schtasks /IT
   交互会话同样挂。判别手段：最小 dioxus-desktop 二进制复现（栈问题而非 app-web
   特有）+ notepad /IT 正常启动（会话健康）+ 复制 DLL 即愈（"main entered"）。
   dx serve 会自动带 DLL，裸 cargo build 不会——部署脚本必须显式复制。

3. **桌面冒烟 = CDP 直驱真 WebView**：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
   --remote-debugging-port=9222` + playwright-core `connectOverCDP`——fill/press
   走真实 WebView 键盘事件 → onkeydown → decide_enter → Event::Submit → Runtime
   → 回环 → trace 文件断言。SendKeys（AppActivate 成功但键不进 WebView 内容区）
   不可靠，弃用。`BH_DEMO_TRACE=<path>` 每次排空原子写台账 = 无头验收面。

4. **两个实录教训**：
   - **渲染体里做状态变更副作用 = 无限循环**：autoplay 放 app() 体 → 每次渲染发
     Edit+Submit → ledger.set → 重渲染 → 再发（trace 里数百条重复提交）。副作用
     必须进 use_effect（无 reactive 依赖只跑一次）。
   - **`EnterDecisionInput` 的 Default 是 can_submit=false**：textarea onkeydown
     用 `..Default::default()` 曾让 Enter 恒 noop（web textarea 模式同样中招）。
     演示显式 `can_submit: true`，空草稿由 Runtime FD06 兜底。

## 已知项 → 已修（2026-11-13，用户拍板「2修」）

- desktop **textarea 模式**提交后草稿残留 `\n` 尾：keydown 的 prevent_default 在
  dioxus-desktop (wry) 上未阻断浏览器默认换行 + 受控值异步同步竞态。island 模式
  （主产品面）无此问题（E2E 4b ✓）。FM11 语义不受影响（快照无 \n）。
- **修复**：JS 同步层 Enter DOM 护栏——document 级 capture 委托监听（对元素重建
  免疫），对 textarea.editor 的非 Shift/非组合 Enter preventDefault（与 island 的
  hand-to-ime DOM 护栏同构，D009）。注意：元素级监听（onmounted eval 内装在
  textarea 上）曾静默失效（CDP 实录 guard:false，机理未查明），document 委托版
  一次安装全生命周期有效。
- **验证**：CDP 冒烟 guard:true + 2 条提交（accepted/queued FM11）+ **draft 干净
  清空（""，此前 "second cdp msg\n"）** VERDICT PASS + island E2E 24/24 回归
  （evidence: phase7-fix2b.log / phase7-fix2-island.log）。

## 后果

- Phase 6 验收达成：Native Core（composer-host 直调）+ 系统 WebView2 面板运行 +
  Enter 提交链端到端实证（accepted + FM11 queued）。
- Phase 7（跨 Host 回归）的 desktop 腿就位：web island 24/24 + desktop CDP 冒烟 +
  React WASM 12/12 三线同协议语义。
