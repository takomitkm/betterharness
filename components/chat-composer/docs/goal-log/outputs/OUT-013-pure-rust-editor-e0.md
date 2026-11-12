# OUT-013：Pure Rust Editor E0 评估完成——taino-edit 判据 9/9，结论 Go

- **轮次**：goal 后第十三次输出
- **日期**：2026-11-13

## 本轮做了什么

1. **同类调查**（pure-rust-editor-survey.md）：Rust 侧唯一真同类 = `taino-edit` 家族
   （Apache-2.0，Dioxus 0.7 原生，214 host tests + 浏览器套件含 IME）；Zed/Lapce 是
   应用非组件，cosmic-text 是布局引擎，Xi 已死，Leptos/Dioxus 生态此前全是 JS 包装。
2. **E0 spike**（spike-taino-composer）：taino-edit + composer-keynav 的 composer
   形态最小编辑器——Enter 仲裁接线、ImeTracker（KD10）、回环台账 + FM01 清空。
3. **判据 9/9 全绿**（CDP 冒烟，校机）：键盘输入/Enter 仲裁/文本正确/FM01 清空/
   失效模式 4/KD03 宽限窗/宽限窗外正常提交/零页面错误。
4. **排障实录**：wasm-bindgen 三版本对齐（0.2.130 统一）、wasm32 无 SystemTime、
   doc content "block+" 空文档非法、Box<dyn Fn> 无 &mut → 事件进协程。

## 验证证据（校机）

- `taino-e2e-criteria7.log`：判据 9/9
- `taino-spike4.log`：门 2 挂载 + 合成组合零损坏
- `taino-spike1.log`：wasm32 构建门 1

## 结论与决策点

**Go 推荐**（判据全过）；E1（island → taino 换装 + 三线回归）待用户拍板后启动。

## 遗留

- E1 前置：app-web pin 0.2.130（本地已改未回归）、undo 栈跨清空的语义评估
- spike 的 composer-keynav path dep 指校机布局（README 已注明）
