# desktop-webview.md（桌面 WebView 测试规范——Phase 6 前置）

> Dioxus Desktop 使用系统 WebView（Wry），不等同统一 Chromium。三个平台的 IME/剪贴板/拖放行为差异需要实测。

## 平台矩阵

| 平台 | WebView | Composer 影响面 | 优先级 |
| --- | --- | --- | --- |
| Windows | WebView2 (Chromium 内核) | IME 即时回调 / 剪贴板 / 拖放 | **最高**（主力开发环境） |
| macOS | WKWebView (WebKit) | IME 组合事件时序可能不同 | 中 |
| Linux | WebKitGTK | IME + 剪贴板行为差异最大 | 低（按需） |

## Windows 验收清单（首个桌面验收目标）

- [ ] 应用启动正常
- [ ] Lexical Island 挂载成功
- [ ] 微软拼音输入（全拼/双拼/中英切换）
- [ ] Enter 提交 / Shift+Enter 换行 / 组合中 Enter 不提交
- [ ] 文件选择器 → 附件卡片
- [ ] 原生拖放文件 → 附件
- [ ] 剪贴板粘贴（文本/图片/文件）
- [ ] Outbox 持久化（重启后恢复）
- [ ] 关闭窗口无任务泄漏
- [ ] Native Core 直调（无 WASM 中间层）

## macOS 验收清单（第二优先级）

- [ ] 同上全项
- [ ] IME 组合事件时序差异记录

## Linux 验收清单（第三优先级）

- [ ] 同上全项
- [ ] WebKitGTK 与 Chromium 差异记录

## 手工 vs 自动化分工

- 自动化（Playwright/MSedge）：功能逻辑验证（Enter 仲裁/Outbox/Effect 回执）
- 手工（真实 OS 输入法）：IME 行为/剪贴板/拖放/焦点切换
- 记录格式：OS 版本 / WebView 版本 / 输入法版本 / 通过-失败 / 截图
