# browser-ime.md（中文 IME 测试规范——Phase 7 前置）

> 中文输入法是 Composer 最高风险的浏览器行为（B12 + KD 契约 + A+ 性能原型第一项）。本文定义自动化覆盖 + 手工验收要求。

## 自动化覆盖（已完成——Phase 1 PoC）

| 用例 | 绑定失效模式 | 测试位置 |
| --- | --- | --- |
| 合成 compositionstart/end + Enter 不提交 | 失效模式 4 | lexical-island browser ✓ |
| 组合结束宽限窗 10ms 严格边界 | 失效模式 5 | keynav.test KD03 + KD11 ✓ |
| Shift+Enter 换行不提交 | 失效模式 6 | browser + KD04 ✓ |
| keyCode 229 信号 | KD02 | keynav.test ✓ |
| isComposing 标志 | KD01 | keynav.test ✓ |
| ImeTracker 生命周期 | KD10 | keynav.test ✓ |
| 纯光标移动不推进版本 | CT06 | completion.test ✓ |

## 手工验收清单（Phase 7 必须——自动化不能替代真实 OS 输入法）

| 场景 | 操作 | 预期 | 已验证 |
| --- | --- | --- | --- |
| 微软拼音 · 全拼 | 输入 nihao → 空格选词 → Enter | 候选确认不提交，文本正确 | ⏳ |
| 微软拼音 · 组合中 Enter | 输入 nihao → Enter（候选未确认） | 不提交，组合继续 | ⏳ |
| 微软拼音 · Shift 中英切换 | Shift → 英文 → Enter | 英文提交 | ⏳ |
| 搜狗输入法 · 全拼 | 同上全流程 | 同上 | ⏳ |
| 搜狗输入法 · 双拼 | 同上 | 同上 | ⏳ |
| macOS 拼音 | 同上（WKWebView 环境） | 同上 | ⏳ |
| Linux iBus | 同上（WebKitGTK 环境） | 同上 | ⏳ |
| 快速连续输入 | 10 字/秒 持续 10s | 无丢字、无误提交 | ⏳ |
| 中英混合 | 中文 → 英文 → 中文 → Enter | 语言边界正确 | ⏳ |
| 失焦恢复 | 输入中切窗 → 回焦点 → 继续 | 文本保留、组合状态重置 | ⏳ |

记录格式：OS 版本 / WebView / 浏览器版本 / 输入法版本 / 通过-失败 / 截图或录屏。

## 已知坑（archive 实录，自动化测试须覆盖）

1. Safari 组合结束后补发 Enter（keyCode 229）→ KD03 宽限窗
2. Lexical 对 Ctrl+Shift+方向键不派发命令 → registerRootListener 原生 keydown
3. Lexical 内部 Selection 滞后于 DOM Selection → DOM 选区事实源
4. editorState.read 不自动设置活动 Editor → editor.read() 封装
5. 组合中 React 重渲染覆盖编辑器文本 → composer-sync 握手
