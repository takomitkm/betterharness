# D014：Pure Rust Editor E0 评估——taino-edit 全判据通过，结论 Go

- **日期**：2026-11-13
- **状态**：E0 完成，判据 9/9 全绿；E1（替换 island）待用户最终拍板
- **关联**：D009（island DOM 护栏）/ D013（三线对拍）；pure-rust-editor-survey.md；OUT-013

## 决定

**E0 结论 = Go**：taino-edit 通过 composer 的全部失效模式判据，成为 Pure Rust Editor
的首选方案（替换 Lexical Island）；自研 fallback 不再需要。

## 判据矩阵（spike-taino-composer，CDP 冒烟 9/9）

| 判据 | 结果 | 说明 |
| --- | --- | --- |
| 键盘输入可见（含中文） | ✓ | 真 WebView 键盘链 |
| Enter → accepted（仲裁接线） | ✓ | taino Keymap 的 "Enter" binding 内跑 composer-keynav decide_enter |
| 文本正确 | ✓ | 回环快照 = 输入文本 |
| FM01 编辑器清空 | ✓ | 交接后 EditorState 置为 doc[空段落] |
| 失效模式 4：组合中 Enter 不提交 | ✓ | ImeTracker（keynav.ts 同款 Rust 最小版）→ hand-to-ime |
| KD03 宽限窗内 Enter 不提交 | ✓ | compositionend 后同任务合成 keydown 被吞 |
| 宽限窗外 Enter 正常提交 | ✓ | 仲裁没有全吞 |
| 零未捕获页面错误 | ✓ | favicon 404 为测试服务器路由缺席 |

## 评估过程实录（每条烧过真金）

- **wasm-bindgen 版本链**：taino-edit lock 0.2.121 / crates.io 0.7 解析到 **0.2.130** /
  我们 pin 0.2.100——三套版本。校机 CLI 已升 0.2.130；app-web pin 同步升 0.2.130
  （bridge 系 crate 浮动 "0.2" 自动跟随）
- **wasm32 无 SystemTime**：`now_ms()` 用 SystemTime 在 wasm 上 panic（time not
  implemented）——Clock 注入纪律的真实原因；spike 改 js_sys::Date::now
- **doc 的 content = "block+"**：空 doc 非法（InvalidContent panic 实录），空编辑器
  = doc 含一个空段落（taino 渲染 `<br data-taino-trailing-break>` 占位）
- **Box<dyn Fn> 里不能拿 &mut**：Enter 命令只发事件，状态变更归协程（composer-host
  同款架构）；Signal 是 Copy 可自由捕获，Schema 非 Copy 从 EditorState.peek().schema() 取
- panic 可观测性：console_error_panic_hook 进 spike（set_hook 需要 Box::new）

## 集成注意事项（E1 前置）

1. app-web pin 0.2.100 → 0.2.130（本地已改，三线回归待重验）
2. taino 的 keymap "Enter" binding 替代 island 的 COMMAND_PRIORITY_HIGH 仲裁
3. ImeTracker 用根级 composition 监听（wrapper div 的 oncompositionstart/end）
4. FM01 清空 = 新空 doc[空段落]（undo 栈会重置——与 Lexical registerHistory 的
   差异需在 E1 评估是否可接受）

## 后果

- Lexical Island 的替换路径成立：纯 Rust 运行时（无 island.js bundle）
- E1 待用户拍板后启动：island → taino 的换装 + 三线回归
- spike 代码入库（spike-taino/，独立 workspace，校机路径 dep 有 README 说明）
