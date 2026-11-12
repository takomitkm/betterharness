# Pure Rust Editor 同类调查与评估计划（Future 项启动）

- **日期**：2026-11-13
- **结论**：**有同类** —— `taino-edit` 家族（2026-05 首发，Apache-2.0，Dioxus 0.7 原生适配）。
  动作改为「评估 → 集成 Go/No-Go」，而非从零自研；自研降为 fallback（有 taino-edit-dom
  的架构作参考实现）。

## 一、调查全景（2026-11 检索）

### Rust 编辑器生态分层

| 层 | 项目 | 状态 | 与「composer 可嵌入编辑组件」的关系 |
| --- | --- | --- | --- |
| 编辑器应用 | Zed（GPU、gpui）、Lapce（xi-rope→自有） | 活跃、成熟 | 是整个应用，不是可嵌入组件；Zed 的 editor crate 绑死 gpui + GPL |
| 终端编辑器 | Helix | 活跃 | TUI，不适用 |
| 文本布局引擎 | cosmic-text（System76）、parley（Linebender） | 活跃 | 布局/shaping，不是带命令/undo/IME 纪律的编辑组件；cosmic-text 的 Editor 仅 plain text |
| 编辑核心库 | Ropey（rope）、xi-rope（随 Lapce 维护） | 活跃 | 数据结构层，供自研用 |
| 已死尝试 | Xi Editor（2019 归档）、Papelito（2023 归档，14 commits） | 死 | — |
| Leptos/Dioxus 的 JS 包装 | leptos-tiptap、tiptap-rs | 活跃但非纯 Rust | 运行时依赖 JS bundle，正是要替换掉的东西 |

### Web 富文本编辑器的 Rust 空缺与填补者

JS 世界 = Lexical / Slate / ProseMirror / Quill / Tiptap。Rust 的 WASM 侧长期空白
（taino-edit 作者自己的调查与本次检索一致），直到：

**`taino-edit`**（juanma-dev/taino-edit）——ProseMirror/TipTap 启发：
- 7 个 crate：core（模型/transforms/state/history/commands/keymap/input-rules）+
  dom（web-sys 桥：mount、diff/patch、selection 同步、**IME composition**、paste、
  drag/drop、MutationObserver→transactions）+ Leptos/Dioxus 薄适配器 + 13 个扩展
  （含表格全家桶）+ Markdown 序列化
- **v0.7 明确适配 Dioxus 0.7**（我们的版本）；MIT OR Apache-2.0（与本项目 GPL-3.0
  兼容，dioxus 依赖本就是 MIT/Apache）
- 测试纪律：**214 项 host 测试** + wasm-bindgen 浏览器套件（headless Chromium：
  mount、diff/patch、selection 同步、DOM-typing→Transform、**IME**、剪贴板、
  拖放、focus、Dioxus 组件/事件/keymap 接线）
- 规模 ~11–15k LOC（core+dom）；作者有完整的 DESIGN_NOTES/ROADMAP

### 成熟度风险（如实）

- 单人维护、16 stars、347 总下载、2026-05 首发到现在 6 个月、11 个版本快速迭代
  （API 未冻结）；8 open issues
- 对比：Lexical（Meta，数百万下载）。taino-edit 是「方向正确的早期项目」，
  不是「经过生产的成熟组件」

## 二、对 composer 的适配分析

我们实际需要的编辑面很窄：**plain text + `\n` 多行、组合输入、undo/redo、选区、
placeholder、clear/setDocument/destroy**。不需要 marks/表格/Markdown。

- Enter 仲裁**不归编辑器**：composer-keynav 的 decide_enter 是权威（KD 契约），
  任何编辑器都只负责「组合状态喂给仲裁 + 仲裁结果的事件路由」——island 现状同构
- FM01（交接清空草稿）走 host 侧 clear() 命令，编辑器只需可靠清空
- IME 纪律（失效模式 4 + KD03 宽限窗）是我们最深的那组测试——**评估的核心就是
  taino-edit 的 composition 处理能否通过我们的失效模式清单**

## 三、E0 评估 spike（Go/No-Go 门）

1. spike crate 引 `taino-edit-dioxus` 0.7：wasm32 编译过门（与我们的
   wasm-bindgen=0.2.100 pin 是否冲突？）
2. 最小编辑器挂进 demo 页：中文合成输入（合成事件流同 B12）+ Enter 仲裁接线
   （keydown → composer-keynav decide_enter → submit-request）
3. 失效模式子集跑分：FM01（交接清空）、失效模式 4（组合中 Enter）、KD03 宽限窗、
   setDocument/undo
4. **Go** = 三项全过 → 进 E1（替换 island，host 契约同构）；**No-Go** → fallback：
   自研 bounded plain-text core（rope/string + transactions + undo + selection，
   DOM 桥参考 taino-edit-dom 的架构分层），按 composer 的失效模式清单建测试

## 四、决策点

E0 结果出来后由用户拍板：Go（吃进外部依赖 + 跟随其 API 迭代）还是 fallback
（自研可控但 IME/DOM 同步的长期维护归我们）。
