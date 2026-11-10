# betterharness 组件计划书：Rust-first 模块化架构

> 本文是 components/ 下所有组件的总计划书（2026-11-11 定案）。
> 许可证：仓库已切换为 **GPL v3**（2051fdd），本目录全部组件按同一许可证发布。
> 结论先行：**不必为了插件生态坚持 TypeScript。以 Rust 为主语言，Dioxus 作为统一 UI 框架，WASM 作为跨平台插件和隔离执行格式。** 这样整个项目的类型系统、数据结构、组件接口更加统一。
>
> 核心追求从来不是 TS，而是三个能力：
>
> 1. 组件可以细粒度拆分和复用。
> 2. 用户可以通过插件重新组合、替换甚至创造功能。
> 3. 同一套实现可以运行在不同操作系统和设备上。
>
> 这三个目标都可以用 Rust 实现。

旧实现（TypeScript 版 chat-composer 与其 Rust 参考核心）已整体归档到
[`chat-composer/archive/`](chat-composer/archive/)，语义与测试记录随之封存；
新实现按本计划书在 [`chat-composer/`](chat-composer/) 重建。

## 1. Dioxus 承担什么

Dioxus 0.7 的平台实现需要特别区分：一份 Rust UI 组件代码适配多平台，而不是所有平台都运行同一个 WASM 文件。

| 平台      | 编译方式        | 渲染方式       |
| ------- | ----------- | ---------- |
| Web     | Rust → WASM | 浏览器 DOM    |
| Windows | Rust 原生二进制  | 系统 WebView |
| Linux   | Rust 原生二进制  | 系统 WebView |
| macOS   | Rust 原生二进制  | 系统 WebView |
| Android | Rust 原生二进制  | 系统 WebView |
| iOS     | Rust 原生二进制  | 系统 WebView |

Dioxus Native 还有基于 WGPU 的独立渲染路线，但目前官方仍将其标注为**实验性**——不要把实验性 Native Renderer 当成必须依赖。

## 2. Dioxus 的一个重要限制：动态插件

Dioxus 的组件是 Rust 函数组件，通过 `rsx!` 宏在编译期形成组件结构。它擅长静态组合和响应式更新，但**不自带**运行期从外部加载新 Rust 组件并插入组件树的插件系统——障碍包括 Rust ABI、组件类型、生命周期与运行时状态管理。

因此提供两种插件方式：

### A. 内置 Rust 插件（性能最好）

插件本身就是 Rust crate，编译期链接进应用，可以直接使用 Dioxus 组件：

```rust
pub fn register(registry: &mut Registry) {
    registry.register_view("message.markdown", MarkdownView);
    registry.register_command("copy", copy_message);
}
```

- 优点：原生类型安全、性能好、可直接写 Dioxus 组件。
- 缺点：新增插件通常需要重新构建或更新应用。

### B. 外部 WASM 插件（适合第三方生态）

第三方用 Rust 编写插件，编译为 WASM，运行时由插件 Host 加载：

```
app
 ├── Dioxus UI
 ├── Rust Runtime
 └── WASM Plugin Host
       ├── plugin-a.wasm
       ├── plugin-b.wasm
       └── plugin-c.wasm
```

研究方向：**WebAssembly Component Model + WIT 接口描述语言**（定义跨语言组件接口、资源与能力边界），**Wasmtime**（Rust 侧的 WASM 执行环境）。

注意：浏览器与原生宿主的 WASM 加载环境不同，不能假设同一个插件包不经过适配就能在所有宿主运行。

## 3. 插件不直接操纵 UI，而是贡献 UI 描述和行为（最值得采用的设计）

插件想给每条消息加一个按钮，不必向 Dioxus 注入 Rust 函数组件，而是注册**贡献（contribution）**：

```yaml
plugin:
  id: message-tools

contributions:
  commands:
    - id: rewrite
      handler: rewrite_message

  ui:
    - slot: message.toolbar
      component: button
      label: Rewrite
      action: rewrite
```

主程序提供组件注册表，PluginSlot 按注册信息构造相应组件：

```
Dioxus UI
  └── MessageView
        └── MessageToolbar
              ├── CopyButton
              ├── RegenerateButton
              └── PluginSlot
                    └── RewriteButton
```

由此实现：

- 插件新增界面元素；
- 插件替换允许覆盖的界面元素；
- 插件改变事件处理逻辑；
- 插件把多个底层组件重新组织成新功能；
- 插件定义自己的命令和工作流。

特别复杂的插件 UI 再提供独立的 UI 扩展接口，不把所有能力限制成按钮、文本和菜单。

## 4. 最终架构

```
Rust-first Modular Architecture

┌─────────────────────────────────────────────┐
│ Dioxus Presentation Layer                    │
│ Chat / Editor / Windows / Panels / Components │
├─────────────────────────────────────────────┤
│ Composition Engine                            │
│ Component Registry / Slots / Hooks / DAG /    │
│ Workflow —— 负责功能重组和依赖解析              │
├──────────────────────┬──────────────────────┤
│ Built-in Plugins      │ External Plugins      │
│ Rust Crates（直接链接）│ WASM Modules（隔离运行）│
├──────────────────────┴──────────────────────┤
│ Shared Rust Core                              │
│ State / Scheduler / Text Engine /             │
│ Message Engine / Editor Engine / Storage      │
├─────────────────────────────────────────────┤
│ Platform Adapters                             │
│ Web / Windows / Linux / macOS / Android / iOS │
└─────────────────────────────────────────────┘
```

### 三种自定义层次

| 层次     | 实现形式             | 是否需要重新编译主程序 |
| ------ | ---------------- | ----------- |
| 组件重组   | TOML / RON / DSL | 不需要         |
| 业务插件   | Rust → WASM      | 不需要         |
| 深度原生扩展 | Rust crate       | 通常需要        |

RON（Rusty Object Notation）对 Rust 类型和枚举结构的表达比较自然，值得优先考虑。

## 5. UI 框架候选对照（保留参照，不早定死渲染路线）

| 框架 | 定位 | 结论 |
| --- | --- | --- |
| [Dioxus](https://dioxuslabs.com) | React 式组件模型，Rust 开发，Web/桌面/移动统一 | **当前首选候选** |
| [Slint](https://slint.dev) | 声明式 UI，桌面/移动/Web/嵌入式，注意评估许可证 | 资源受限场景的备选 |
| [GPUI](https://github.com/zed-industries/zed)（Zed） | 桌面高性能 UI，值得研究复杂编辑器、文本布局、高交互性能 | 研究参照，不为它放弃统一多平台架构 |

**不要过早定死 Dioxus WebView vs Dioxus Native 的渲染路线。** 对话界面与编辑器都值得先做性能原型，重点测：输入延迟、中文 IME、流式 Markdown、长文档虚拟化、滚动性能、插件开销。

## 6. 三个已定的架构决策

- 主语言：Rust
- UI 框架：Dioxus
- 跨平台插件：WASM
- 组件组合：Rust Composition Engine + 声明式 DSL
- 原生执行：Rust Native Runtime
- Web 执行：Rust WASM Runtime

当前研究重点已经从「Rust 和 TS 怎么胶合」变成**「如何设计一套与 UI 框架无关的 Rust 组件协议与插件 ABI」**——协议做好后，将来把 Dioxus 换成 GPUI、Slint 或其他框架，核心组件、工作流和插件都不必推倒重写。

## 7. chat-composer：旧实现的功能搬迁矩阵

旧 TS 实现（archive/ts，门禁 76 单元 + 34 浏览器 + 14 变异全绿）已实现的功能，在新 Rust 实现中的落点：

| 已实现功能 | 旧位置（archive/ts） | 新位置（chat-composer/crates） |
| --- | --- | --- |
| 可靠提交：持久 outbox、unknown 永不自动重发、回执只结算自己的消息、queue/steer/none、逐条取回 | core.ts + core-rs/state.rs | `composer-core`（吸收 core-rs 台账，补齐 core.ts 语义） |
| Enter/IME 仲裁（组合保护 + 10ms 优雅窗 + 菜单/重复/提交优先级） | key-decision.ts | `composer-rules`（keynav 模块） |
| @// 候选菜单（触发检测、代次防过期、一次选择一次撤销） | completion.ts | `composer-rules`（completion 模块） |
| 统一文件准入（整批/逐文件策略、粘贴路由） | intake.ts | `composer-rules`（intake 模块） |
| 正文附件插入/前后移动/一步撤销（移动跨度） | reorder.ts + LexicalEditor | `composer-rules`（reorder 模块）+ UI 层 |
| 有序文档与附件身份校验 | snapshots.ts | `composer-rules`（snapshot 模块） |
| 附件卡片（alt 替代文本、压缩/原图开关、MIME 引用克隆） | AttachmentCards.tsx + LexicalEditor | 内置插件 `plugin-attachment-tools`（示范插件贡献机制） |
| 可见队列 dock | ChatComposer.tsx outbox | `app-web`（Dioxus 面板） |
| 富文本编辑器（Lexical）与 DOM 粘贴/拖放 | LexicalEditor.tsx | `app-web` 平台适配层（Web 用 DOM；富文本能力随平台演进，见 §5 性能原型） |
| IndexedDB CAS 持久化 / HTTP 回执 | store.ts / http-transport.ts | `composer-core` 的 Storage/Transport trait + 平台适配实现 |

旧实现的完整行为契约与测试清单见 [`chat-composer/archive/ts/README.md`](chat-composer/archive/ts/README.md)。

## 8. 本次施工范围

- 计划书（本文）。
- 旧实现归档（archive/ts、archive/rust）。
- 新 Rust workspace：composer-core + 细规则 crates + plugin-api + composition + 内置插件 attachment-tools，全部带原生测试。
- Dioxus web 演示面板：接线已实现功能的核心状态（草稿、发送、队列、卡片、菜单仲裁）。
- WASM 外部插件宿主（Wasmtime/WIT）为下一步，不在本次范围；plugin-api 先以 trait 定接口，避免协议返工。
