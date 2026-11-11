# BetterHarness Product Line Plan A+
# Dioxus-first Rust UI + Lexical Editor Island + Rust Core

> 编者注（2026-11-12 收编）：本文正式取代原「React + Lexical 产品线恢复与双 Host」计划
> （v1，git 历史 4fc2b58 可查；React 线按本文 1.2 转为参考实现与测试基准，不再扩大）。
> 决策链：D005（乙/甲对比）→ D006（采纳 Plan A+ 为产品方向，门控渐进）→ 本文（A+ 正式执行计划）。
> 执行状态快照见文首编者注与 `docs/goal-log/`。

**状态：** Proposed / Implementation Plan
**产品方向：** Dioxus-first
**工程基线：** 以 Agent 开始执行时的实际 Git HEAD 和工作树为准
**决策依据：** D005 及本次新增的 Plan A+ 方案
**主要目标：** 将 Dioxus `app-web` 从架构验证应用升级为产品 UI，复用已验证的 Lexical 编辑器能力，最终形成 Rust 主导的 Web / Desktop 应用。

---

# 0. 执行摘要

## 0.1 最终决策

产品 UI 采用 Dioxus 0.7。

编辑器采用 Lexical Vanilla JS，独立封装为编辑器组件，不依赖 React。

业务逻辑继续由 Rust Core 承担。

Web 和 Desktop 分别运行同一套 Rust Core：

- Web：Dioxus Web + Rust WASM Core。
- Desktop：Dioxus Desktop + Native Rust Core。

最终目标结构：

```
                    BetterHarness
                         |
                  Dioxus Application
                         |
            +------------+------------+
            |                         |
        Rust UI                  Lexical Island
            |                      Vanilla TS
            |                         |
            |                     Browser DOM
            |                         |
            +------------+------------+
                         |
                  Composer Adapter
                         |
                 Existing Protocol
                         |
                  composer-runtime
                         |
                    composer-core
                         |
              plugin-api / composition
```

这里有三个明确的边界：

1. Dioxus 负责产品 UI，不再以 React 作为产品前端。
2. Lexical 只负责浏览器编辑能力，不承担业务状态管理。
3. Rust Core 是唯一业务逻辑源，所有 Host 均复用同一套业务语义。

## 0.2 为什么不继续使用 React + Lexical

计划乙已经证明 React + Lexical 可以工作，但用户希望产品本身由 Rust 主导。

因此不再继续扩大 React 产品线，而是提取 Lexical 的框架无关部分：

- 保留 Lexical 编辑器核心。
- 保留必要的 Lexical Nodes。
- 保留 History、Clipboard、Key Commands。
- 保留浏览器行为测试。
- 移除对 `@lexical/react` 的运行时依赖。
- Dioxus 接管 Composer 的外围 UI 和交互。

Lexical 官方提供 Vanilla JS 使用路径，其核心和 Extension 可以脱离 React 使用。具体应以当前仓库锁定的 Lexical 版本为准，不能为了使用新版 API 而盲目升级。

## 0.3 Rust 化范围

| 部分                 | 最终实现               |
| ------------------ | ------------------ |
| 主应用布局              | Rust / Dioxus      |
| 会话列表               | Rust / Dioxus      |
| 消息列表               | Rust / Dioxus      |
| Composer 外围 UI     | Rust / Dioxus      |
| 工具栏与菜单             | Rust / Dioxus      |
| 插件 UI 容器           | Rust / Dioxus      |
| 核心状态机              | Rust               |
| 事件与 Effect         | Rust               |
| Plugin System      | Rust               |
| 富文本编辑器内核           | Lexical Vanilla JS |
| 编辑器与 DOM 的交互       | Lexical            |
| Web / Desktop Host | Rust               |

本计划不是声称整个前端已经 100% Rust。

Lexical 是一个被严格隔离的 JS 子系统。它不允许把 React、JavaScript 业务状态或新的 TS Core 重新引入主应用。

---

# 一、当前工程基线与迁移保护

## 1.1 最近一次已知执行状态

根据现有执行报告：

| 部分               | 最近一次已知状态                                              |
| ---------------- | ----------------------------------------------------- |
| composer-core    | 已有 Rust 实现                                            |
| composer-runtime | 已有 Rust 实现                                            |
| 规则组件             | keynav / completion / intake / reorder / snapshot 已存在 |
| Plugin System    | plugin-api / composition 已存在                          |
| Dioxus           | `app-web` 已有 Dioxus 0.7 实现                            |
| WASM Core        | 已有真实运行验证                                              |
| React + Lexical  | 已恢复为可运行参考实现                                           |
| Bridge           | 7/7 测试通过，BM05 协议形状冻结                                  |
| CAS              | BM07 `persist_revision` 已测绿                           |
| Browser E2E      | 真实 WASM Core，10/10                                    |
| React 浏览器测试      | B01–B32 对应的 34 项用例已恢复实测 34/34                         |
| 额外测试             | 76 单元测试、14 项变异同步测试已恢复                                 |
| IDB              | 适配器及 WasmEngine 接线曾处于未测完状态                            |
| Tauri Host       | 本计划不再采用                                               |
| Dioxus Desktop   | 尚需实现或验收                                               |

注意：

以上是已有报告中的状态，不代表执行本计划时 Git 工作树仍然完全相同。

Agent 必须重新检查当前 HEAD、提交历史、未提交文件和最新测试结果。

## 1.2 必须保留的历史资产

### Rust Core

以下 crate 不属于本次重写范围：

- composer-core
- composer-runtime
- keynav
- completion
- intake
- reorder
- snapshot
- plugin-api
- composition

### React / Lexical

原有 React 实现不再作为产品 UI，但在迁移完成以前必须保留：

- 原始 React + Lexical 实现。
- B01–B32 全部 34 项浏览器用例。
- 76 项单元测试。
- 14 项变异同步测试。
- 现有 10 项真实 WASM Core E2E。
- IME 实验记录。
- DOM Selection 处理记录。
- 剪贴板 MIME 记录。
- Lexical 历史 Bug 修复和回归测试。

迁移完成以前，React 实现是对照组。

不得提前删除。

### Dioxus

现有 `app-web` 作为主产品线的起点。

优先在现有目录里升级，不要未经检查就新建一个重复的 `app-dioxus`。

### 未提交修改

开始工作时必须检查：

```
git status --short --branch
git log --oneline -20
git diff
git diff --cached
```

特别检查：

- `persist_revision`
- BM07 测试
- IndexedDB 适配器
- WasmEngine 接线
- Dioxus `app-web` 当前状态
- `PRODUCT-LINE-PLAN.md`
- D005 决策记录

禁止：

- `git reset --hard`
- `git clean -fd`
- 覆盖未提交文件
- 未检查就执行大规模 cherry-pick
- 将尚未验证的 IDB 代码标记为完成
- 擅自删除 React 参考实现

必须先生成迁移前工作树快照报告。

## 1.3 决策记录

保留原有 D005，不修改历史决策的原始内容。

新增一条决策记录，例如：

`docs/goal-log/decisions/D006-dioxus-first-product-line.md`

具体命名遵循现有仓库规则。

新决策应说明：

- D005 当时选择 React 产品线的依据。
- 现在为什么调整产品方向。
- React 已完成的工作如何转化为参考资产。
- 为什么选择 Dioxus + Lexical Vanilla。
- 为什么暂时不采用纯 Rust 编辑器。
- 计划 A+ 与未来纯 Rust 编辑器实验的关系。

如果仓库中的 D005 不是本轮描述的决策内容，以实际文件为准，不得虚构或覆盖记录。

---

# 二、目标架构

## 2.1 产品架构

```
BetterHarness
│
├── app-ui
│   │
│   ├── shell
│   ├── navigation
│   ├── workspace
│   ├── conversation
│   ├── message-list
│   ├── composer
│   │   ├── ComposerShell
│   │   ├── LexicalIsland
│   │   ├── AttachmentLayer
│   │   ├── CompletionLayer
│   │   └── Toolbar
│   │
│   └── plugin-ui
│
├── lexical-island
│   ├── Lexical Controller
│   ├── Custom Nodes
│   ├── History
│   ├── Clipboard
│   ├── Commands
│   └── Browser Tests
│
├── composer-adapter
│   ├── Composer Protocol
│   ├── Runtime Adapter
│   ├── Snapshot Subscription
│   └── Effect Handling
│
├── composer-runtime
├── composer-core
├── plugin-api
└── composition
```

各部分技术选择：

| 部分      | 技术                      |
| ------- | ----------------------- |
| UI      | Dioxus 0.7              |
| 页面布局    | RSX                     |
| 样式      | CSS                     |
| 响应式状态   | Dioxus Signals / Stores |
| 编辑器     | Lexical Vanilla         |
| JS 编译   | 现有 Node 工具链             |
| Core    | Rust                    |
| Web     | WASM                    |
| Desktop | Dioxus Desktop          |
| 桌面窗口后端  | Dioxus Desktop / Wry    |
| 协议      | 已冻结 Composer Protocol   |

## 2.2 Web 执行路径

```
Browser
   |
   +-- Dioxus UI (WASM)
   |       |
   |       +-- app-ui
   |       |
   |       +-- composer-adapter
   |       |
   |       +-- composer-runtime
   |       |
   |       +-- composer-core
   |
   +-- Lexical JS Bundle
           |
           +-- DOM
           +-- IME
           +-- Selection
           +-- Clipboard
```

Dioxus 和 Core 如果在同一个 Rust WASM 应用中，可以直接在 Rust 内部调用，不需要把 Core 再导出给 JavaScript。

Lexical 只通过明确的编辑器接口与 Dioxus 交互。

## 2.3 Desktop 执行路径

```
Desktop Application
       |
       +-- Dioxus Desktop UI
       |       |
       |       +-- app-ui
       |       |
       |       +-- composer-adapter
       |       |
       |       +-- composer-runtime (Native)
       |       |
       |       +-- composer-core
       |
       +-- System WebView
               |
               +-- Lexical JS Bundle
```

Desktop 不使用 WASM 运行 Core。

Desktop 也不需要额外增加 Tauri 2 作为第二层壳。

Dioxus Desktop 本身就是基于 WebView 的桌面渲染方案，Rust 代码运行在 Native 环境。

---

# 三、Phase 0：迁移前审计和基线冻结

**目标：先确认当前已有实现，禁止重复实现。**

## 3.1 仓库审计

检查：

- 当前 Cargo Workspace。
- 当前 Dioxus `app-web`。
- 当前 React 产品线。
- `archive/ts`。
- `archive/rust`。
- `PRODUCT-LINE-PLAN.md`。
- D005。
- BM05、BM07。
- 已有桥接 DTO。
- 现有 IDB 接线。
- 当前测试脚本。

输出：

`docs/architecture/plan-a-plus-migration-inventory.md`

内容：

1. 当前 Git 提交状态。
2. 当前工作树状态。
3. 已交付成果。
4. 未完成成果。
5. React 资产列表。
6. Dioxus 资产列表。
7. Lexical 组件依赖关系。
8. Core 公开 API。
9. Bridge 协议。
10. 需要迁移的具体接口。

## 3.2 测试基线

至少记录：

- Workspace Rust 测试。
- Core 测试。
- Runtime 测试。
- FM 对拍测试。
- BM05 协议测试。
- BM07 CAS 测试。
- 76 项单元测试。
- 14 项变异同步测试。
- B01–B32 对应的 34 项测试。
- Node 冒烟测试。
- 真实 WASM Browser E2E 10/10。

不能把原本通过的测试从 CI 移除后宣称迁移成功。

不能将参考实现测试与新产品线测试混为一谈。

## 3.3 工作树保护

先处理已验证但尚未提交的代码。

对于 BM07：

- 检查 `persist_revision` 的当前实现。
- 确认测试通过。
- 检查是否存在与其他改动混杂的问题。
- 与未完成 IDB 接线分离。
- 按照仓库提交规范处理。

对于 IDB：

- 不假定当前代码已经可用。
- 不覆盖已有实现。
- 不直接从头重写。
- 先厘清适配器与 Core 的依赖关系。

Phase 0 完成后，必须有一份可追溯的基线报告。

---

# 四、Phase 1：Lexical Vanilla 化 PoC

**这是全计划最重要的风险验证阶段，必须优先完成。**

目标不是重写 Lexical，而是证明：

原有已经通过测试的 Lexical Composer，能够在不使用 React 的情况下继续提供同样的浏览器编辑能力。

## 4.1 检查 Lexical 版本

首先检查 `archive/ts` 的 package.json 和锁文件。

记录：

- lexical 版本。
- 所有 `@lexical/*` 包版本。
- React 版本。
- 各个 React Plugin。
- 自定义 Node。
- 自定义 Command。
- 自定义 Extension。
- CSS 依赖。
- 测试框架。

遵循：

**迁移期间不升级 Lexical。**

Lexical 和 `@lexical/*` 包版本必须一致，避免出现多份 Lexical Core。

只有当当前版本不支持所需的 Vanilla API 时，才允许单独提出升级计划。

新版 Lexical 已经提供 Vanilla JS 和 Extension 使用方式，但迁移应首先依据当前锁定版本的真实 API，而不是直接套用最新版文档。

## 4.2 建立 React Plugin 映射表

逐个审查原来的 React 组件和插件。

| 原实现              | Vanilla 目标                       |
| ---------------- | -------------------------------- |
| LexicalComposer  | `createEditor` 或当前版本对应的原生初始化 API |
| ContentEditable  | 独立的编辑器 DOM Root                  |
| HistoryPlugin    | 对应版本的 History 注册 API             |
| OnChangePlugin   | `registerUpdateListener`         |
| RichTextPlugin   | Lexical 原生节点和扩展                  |
| KeyCommandPlugin | `registerCommand`                |
| 自定义 React Plugin | Extension / Command / Listener   |
| ErrorBoundary    | Lexical `onError` 和外层错误处理        |
| React Hook       | Controller 内部生命周期管理              |

注意：

以上是迁移方向，不代表每个旧 Plugin 都有一对一替代 API。

必须根据锁定版本的实际源码逐项映射。

## 4.3 建立 Vanilla Controller

建议独立目录：

```
lexical-island/
  src/
    editor/
      create-controller.ts
      editor-controller.ts
      editor-config.ts
    extensions/
      history.ts
      rich-text.ts
      clipboard.ts
      keynav.ts
      completion.ts
      attachments.ts
    nodes/
    commands/
    protocol/
    styles/
  tests/
```

目录名按现有 Node Workspace 结构调整。

Controller 是唯一管理 Lexical 实例的对象。

参考接口：

```
interface LexicalController {
  focus(): void;

  blur(): void;

  clear(): void;

  executeCommand(
    command: EditorCommand
  ): void;

  getDocument(): SerializedEditorState;

  getPlainText(): string;

  setDocument(
    state: SerializedEditorState
  ): void;

  setDisabled(
    disabled: boolean
  ): void;

  destroy(): void;
}
```

必须确认每个方法在当前 Lexical 版本中如何正确实现。

特别注意：

- `getDocument()` 必须在合法的 Editor State 读取上下文中执行。
- 不能假设每次调用都会自动建立活动 Editor。
- 不得在异步回调中访问已经销毁的 Editor。
- 不得把内部 DOM Selection 简化成字符串偏移量后再假定可以完整恢复。

## 4.4 编辑器 DOM 所有权

采用隔离的 Editor Island：

```
Dioxus Component
    |
    +-- Editor Container (Dioxus owns)
            |
            +-- Lexical Root (Lexical owns)
                    |
                    +-- Paragraphs
                    +-- Text Nodes
                    +-- Custom Nodes
                    +-- Selection
```

规则：

- Dioxus 管理外层容器。
- Lexical 管理容器内的编辑器 DOM。
- Dioxus 不得在 Lexical Root 内持续执行 DOM reconciliation。
- Lexical 不得修改 Dioxus 管理的其他元素。
- Dioxus 更新状态不能导致编辑器被意外销毁重建。
- 同一容器不得反复初始化多个 Lexical Editor 实例。

初期不引入 Shadow DOM。

原因是需要最大限度保留已经验证过的 Selection、IME、Clipboard 和 CSS 行为，避免增加新的变量。

## 4.5 对外接口

编辑器对外只提供命令和事件。

例如：

```
type EditorCommand =
  | { type: "focus" }
  | { type: "clear" }
  | { type: "insert-text"; text: string }
  | { type: "set-disabled"; value: boolean }
  | { type: "submit-request" };

type EditorEvent =
  | { type: "ready"; instanceId: string }
  | { type: "document-changed"; revision: number }
  | { type: "submit-request"; document: SerializedEditorState }
  | { type: "attachment-added"; attachment: AttachmentMetadata }
  | { type: "error"; message: string };
```

这些只属于 Editor Island 的接口。

不得修改已经冻结的 Composer Bridge 协议来适应 Lexical。

需要在 Editor Island 协议中增加版本字段和实例 ID，防止多个 Composer 编辑器互相干扰。

编辑器状态变化不意味着每次都要向 Rust Core 发送完整内容。

应当以现有 Core Event 和 Bridge 契约为准。

## 4.6 挂载方式

优先实现：

```
Dioxus LexicalIsland Component
       |
       +-- 创建稳定 DOM 容器
       |
       +-- 初始化 Vanilla Controller
       |
       +-- 监听 EditorEvent
       |
       +-- 转发 EditorCommand
       |
       +-- 组件销毁时 destroy()
```

建议先通过 Dioxus `onmounted` / 生命周期机制和 JS Controller 完成挂载。

Dioxus 0.7 提供 `document::eval` 等 JavaScript 交互能力。Web 和 Desktop 的具体调用方式必须在 PoC 中验证，避免直接把 Web-only 的 `web-sys` 代码放入 Desktop 共用部分。

如果稳定容器和生命周期交互不可靠，再评估 Custom Element。

不允许同时引入多套互相竞争的挂载机制。

## 4.7 PoC 测试

必须完成：

- React 运行时不再参与 Lexical 初始化。
- 可以创建 Lexical Editor。
- 可以输入和删除文本。
- 可以获取序列化状态。
- 可以清空编辑器。
- 可以注册和执行 Command。
- 可以卸载和重新挂载。
- 不产生重复 Editor 实例。
- 不发生 DOM 双重管理。

## 4.8 Phase 1 Go / No-Go

必须达到：

- 目标 Lexical 功能完整。
- 无 React 运行时依赖。
- 原始 B 系列测试可迁移到 Vanilla Controller。
- 原有输入、选区和撤销行为没有退化。
- Dioxus 可以稳定挂载、操作和销毁 Editor Island。

如果不能达到，不允许直接切换到自研编辑器。

先提交问题清单和最小复现。

---

# 五、Phase 2：Dioxus 产品 UI

**目标：让 Dioxus 从架构实验升级为产品主 UI。**

复用现有 `app-web`，避免新建第二套重复界面。

## 5.1 UI 组件结构

建议：

```
app-ui/
  src/
    app/
    shell/
    navigation/
    workspace/
    conversation/
    message-list/
    composer/
      shell.rs
      editor_island.rs
      toolbar.rs
      attachments.rs
      completion.rs
      status.rs
    panels/
    plugin_ui/
    theme/
```

按照现有代码结构逐步拆分。

不要为了符合目录结构而大规模移动已有代码。

## 5.2 Composer 外围 UI

Composer 除了编辑器本体，全部由 Dioxus 实现：

- 输入区域布局。
- 工具栏。
- 发送按钮。
- 发送状态。
- 附件列表。
- 附件移除。
- 自动补全面板。
- Slash Command 菜单。
- 模型选择。
- Agent 选择。
- 上下文状态。
- 插件按钮。
- 拖放提示。
- 错误和恢复提示。

Lexical 只管理编辑器内部。

不要把工具栏、模型选择器、发送按钮也塞进 Lexical。

## 5.3 React 退出产品 UI

最终产品不应依赖：

- React DOM。
- React Runtime。
- `@lexical/react`。
- React Context。
- React Hooks。
- React 版 Composer Provider。

允许在开发阶段保留：

- React 参考应用。
- 原有测试驱动。
- 对照实验。
- 资产恢复工具。

最终交付时，应当能够通过依赖分析证明产品运行时没有引入 React。

## 5.4 Dioxus 状态管理

区分：

**UI 临时状态：**

- 面板展开。
- 当前 Tab。
- Hover。
- 弹出菜单。
- 工具栏选中。
- 窗口布局。

由 Dioxus Signals 管理。

**编辑器状态：**

- Selection。
- 光标。
- IME。
- Undo/Redo。
- DOM。
- 输入法候选过程。

由 Lexical 管理。

**业务状态：**

- Draft 身份。
- Submit。
- Outbox。
- Effect。
- Agent/Plugin 业务状态。
- 持久化状态。

由 Rust Core 管理。

同一业务状态不得在 Dioxus、Lexical、Core 三处同时维护为可独立写入的权威状态。

---

# 六、Phase 3：Lexical 与 Dioxus 集成

## 6.1 事件流

```
用户输入
   |
   v
Browser IME / DOM
   |
   v
Lexical Editor
   |
   +-- Selection
   +-- History
   +-- Custom Nodes
   +-- Clipboard
   |
   v
EditorEvent
   |
   v
Dioxus LexicalIsland
   |
   v
Dioxus Composer Component
```

反向调用：

```
Dioxus UI
   |
   v
EditorCommand
   |
   v
Lexical Controller
   |
   v
Editor API
```

## 6.2 禁止的数据流

禁止：

```
Lexical change
    |
    v
Dioxus Signal
    |
    v
重新设置整个 Editor State
    |
    v
重新创建 DOM
```

禁止在每一轮 Rust Snapshot 到达时重新初始化 Lexical。

禁止在 composition 尚未结束时用外部内容覆盖输入。

禁止将 Dioxus 的文本状态作为 DOM Selection 的事实源。

## 6.3 Submit 流程

实际数据以现有 Composer Protocol 为准，目标行为：

```
用户输入
   |
Lexical Controller
   |
Submit Command
   |
获取当前有效编辑内容
   |
Dioxus 提交事件
   |
Rust Composer Adapter
   |
composer-runtime
   |
Outbox / Accepted
   |
Snapshot 更新
   |
Dioxus UI
```

验收必须覆盖：

- 空消息。
- 普通文本。
- 富文本。
- 多段文本。
- 附件。
- 快捷键提交。
- 点击发送。
- 提交失败。
- 重复提交。
- Submit 与 IME composition 冲突。

提交成功以后，编辑器清空、草稿切换或恢复的时机必须由业务流程明确决定。

不得仅仅在点击发送按钮时无条件清空编辑器。

---

# 七、Phase 4：接入现有 Rust Core 和 Bridge

**目标：在不改变现有业务语义的前提下，让 Dioxus 直接使用 Rust Core。**

## 7.1 Bridge 原则

BM05 已冻结的协议形状继续保留。

BM07 CAS 语义继续保留。

不得因为 Dioxus 是 Rust UI，就随意修改事件名称、状态定义、错误类型和 revision 语义。

本次允许增加的内容仅限于：

- Dioxus 侧调用适配。
- 必需的 Host 生命周期接口。
- 与 Editor Island 有关的独立接口。
- 已确认必要的持久化适配。

如果发现协议确实存在缺陷，先提交独立 ADR 和兼容性测试，不得在 UI 迁移中顺手修改。

## 7.2 Dioxus Rust Adapter

Dioxus 与 Core 位于同一个 Rust 应用时，不需要再用 JavaScript 作为 Core 调用中介。

建议建立：

```
Dioxus Components
       |
       v
Composer Adapter
       |
       v
Existing Composer Protocol
       |
       v
composer-runtime
       |
       v
composer-core
```

Adapter 可以在内部直接调用 Rust Runtime。

但必须维持现有协议的：

- 事件含义。
- 事件处理顺序。
- Snapshot 语义。
- revision。
- Effect 处理。
- 错误映射。
- 幂等性。
- CAS 约束。

不要为追求"全程零序列化"而绕开协议测试。

必要时可以在 Rust 内部使用强类型 DTO 直接传递，避免不必要的 JSON 编解码。

## 7.3 React 参考实现

原 React Host 继续作为兼容性参考，直到 Dioxus 完成同等行为验收。

执行：

- 使用同一组输入事件。
- 使用同一组业务事件。
- 比较相同的业务结果。
- 验证 Dioxus 没有引入新的事务语义。

不能要求 Dioxus 必须复用 React 的 JS Bridge 实现。

要求复用的是协议和业务语义，不是同一段调用代码。

## 7.4 Effect 生命周期

必须复用 composer-runtime 当前的 Effect 处理方式。

区分：

1. Core 内部 Effect。
2. Browser Host Effect。
3. Desktop Host Effect。
4. Plugin Effect。

不能让 Dioxus 再实现第二套业务补偿逻辑。

已有 Fiber 和可逆副作用语义必须保持。

## 7.5 Snapshot

继续使用现有 Snapshot 模型。

确保：

- revision 单调递增。
- 订阅初始化不存在竞态。
- 过期快照不会覆盖新状态。
- Dispose 不影响仍然存活的 Runtime。
- Dioxus 组件重建不会意外创建新的业务 Runtime。

不要在 UI 中复制一份拥有独立写入权的业务台账。

---

# 八、Phase 5：IndexedDB 与持久化

**目标：Web 数据可以真正持久保存，而不是仅在当前运行周期中有效。**

这是计划乙遗留的工作，应独立完成，不要和编辑器迁移混成一个大型改动。

## 8.1 首先审查现有实现

检查：

- `persist_revision`
- BM07 测试
- IDB Adapter
- WasmEngine
- 当前持久化接口
- 浏览器数据结构
- 恢复流程

未完成的 IDB 接线必须单独审查和测试。

不得直接假设它已经实现了原子事务。

## 8.2 持久化职责

Rust Core 定义业务状态和持久化所需的语义。

平台适配器提供具体存储能力：

```
composer-runtime
       |
Persistence Port
       |
   +---+----+
   |        |
  Web    Desktop
   |        |
IndexedDB  Native Storage
```

Web：

- IndexedDB。
- 原子事务。
- CAS / revision。
- 断电或页面关闭后的恢复。
- schema version。
- migration。

Desktop：

- 优先复用已有 Native Storage 方案。
- 如需 SQLite 或其他存储，单独评估。
- 不为了与 Web 统一而强迫桌面使用 IndexedDB。

## 8.3 验收

- 刷新浏览器后能够恢复。
- 浏览器关闭后仍可恢复。
- 重复提交不会造成重复事务。
- CAS 冲突可以正确处理。
- 不完整写入不能被误认为完成。
- migration 可重复执行。
- schema 不兼容时有明确错误和恢复路径。

---

# 九、Phase 6：Dioxus Desktop

**目标：在 Web 产品 UI 稳定后，通过 Dioxus Desktop 构建桌面应用。**

本方案不使用 Tauri 2 再包一层。

## 9.1 总体结构

```
Dioxus Desktop
      |
     Wry
      |
System WebView
      |
Lexical JavaScript
      |
Native Rust Application
      |
composer-runtime
      |
composer-core
```

UI 组件尽可能共用 `app-ui`。

Desktop 使用 Native Rust Core。

## 9.2 平台差异

Dioxus Desktop 基于系统 WebView，不等于拥有统一的 Chromium 环境。

至少考虑：

| 平台      | WebView   |
| ------- | --------- |
| Windows | WebView2  |
| macOS   | WKWebView |
| Linux   | WebKitGTK |

优先完成 Windows 桌面验收。

之后依次扩展 macOS、Linux。

不要默认浏览器 Edge 中通过的输入法测试等于桌面 WebView 中也通过。

## 9.3 原生能力

Desktop Host 负责：

- 文件选择。
- 文件读写。
- 文件拖放。
- 系统剪贴板。
- 窗口生命周期。
- 系统通知。
- 托盘。
- 应用级快捷键。
- 本地持久化。

所有系统能力通过 Rust Host 提供。

Lexical 只负责编辑器内部交互。

Dioxus Desktop 的 JavaScript 交互需要经过稳定的 JS Adapter，不得把 Web-only `web-sys` API 直接放入 Desktop 共用代码。

## 9.4 Desktop 验收

- 应用可以正常启动。
- Lexical 可以挂载。
- 输入和 IME 工作。
- 编辑器可以正常销毁。
- Native Core 能正常工作。
- 文件选择和附件流程正确。
- 重启后数据可恢复。
- 关闭窗口后无任务泄漏。
- 没有通过 WASM 间接调用 Native Core。

---

# 十、Phase 7：浏览器行为和兼容性回归

## 10.1 B 系列恢复

历史测试实际是 B01–B32 编号，对应 34 个测试用例。

必须保留原有编号与原始测试目标。

将测试分成：

- Lexical Controller 单元测试。
- Vanilla Editor 浏览器测试。
- Dioxus UI 集成测试。
- Core / Bridge Conformance 测试。

不要把 React 组件测试机械复制成 Dioxus 测试。

测试真正的行为契约。

## 10.2 中文 IME

必须覆盖：

- `compositionstart`
- `compositionupdate`
- `compositionend`
- 中文候选词输入。
- 候选词确认。
- 候选词未确认时 Enter。
- Shift + Enter。
- 快速连续输入。
- 中英文混合输入。
- composition 期间收到业务 Snapshot。
- composition 期间 Dioxus 发生重新渲染。
- 编辑器焦点丢失后恢复。
- 输入过程中执行快捷键。

自动化测试不能完全替代真实操作系统输入法。

至少保留 Windows 中文输入法手工测试。

建议记录操作系统、WebView、浏览器版本和输入法版本。

## 10.3 Selection

覆盖：

- DOM Selection。
- Lexical Selection。
- 方向键。
- Ctrl + 方向键。
- Ctrl + Shift + 方向键。
- Home / End。
- Shift + Home / End。
- 多段文本选择。
- 选区跨节点。
- 选区恢复。
- 选区与外部 UI 更新并发。

原有三项已修复的 Lexical 问题必须保留回归测试：

- `isMoveForward` 位掩码问题。
- 内部 Selection 滞后。
- `editorState.read` 活动 Editor 上下文问题。

## 10.4 Clipboard

覆盖：

- 纯文本。
- HTML。
- 图片。
- 文件。
- 多 MIME。
- 不支持的 MIME。
- 大文件。
- 原生拖放。
- 重复粘贴。
- 失败恢复。

## 10.5 附件混排

必须使用真实 Lexical Custom Node 或当前版本对应的 Extension 实现。

检查：

- 正文与附件混排。
- 附件前后光标定位。
- 删除附件。
- 复制和粘贴附件。
- 拖放附件。
- Undo / Redo。
- 序列化和反序列化。
- 提交后的附件归属。

文件二进制不要通过 JSON Base64 反复传输。

优先使用平台文件句柄或 IDB Blob / Native 临时文件，Core 保存稳定的附件业务标识和必要元数据。

---

# 十一、Rust 编辑器路线：保留为未来替换目标

本计划不会永久放弃全 Rust 编辑器。

但不把它放在当前产品交付的关键路径上。

建议独立记录：

`docs/experiments/editor-rs/`

测试目标：

1. 中文 IME。
2. DOM Selection。
3. 正文内附件混排。
4. 撤销栈。
5. 剪贴板 MIME。
6. 快捷键。
7. Undo / Redo。
8. 可访问性。
9. 大量文本输入性能。
10. 长文档性能。

## 11.1 替换 Lexical 的准入条件

Rust 编辑器必须同时满足：

- IME 手工测试通过。
- Selection 行为通过。
- 正文内附件混排通过。
- Undo / Redo 通过。
- 剪贴板 MIME 测试通过。
- 与 Lexical 使用相同的编辑器行为测试。
- 性能达到或超过当前 Lexical 基线。
- 能在目标 WebView 中稳定运行。

未达到全部条件前，不允许替换产品线 Lexical。

将来替换时，只更换 Editor Adapter，不修改 Rust Core 或 Composer Protocol。

---

# 十二、Plugin System 与 WASM Components

现有 Cordis 式 Rust Plugin System 保持不动。

包括：

- plugin-api
- Fiber
- 可逆副作用
- composition
- Profile
- Bundle
- Patch

不要把 UI 框架迁移和插件运行时重构绑定在一起。

关于 WASM Components：

- 当前 plugin-api 是已有业务插件体系。
- WASM Component Model 的插件沙箱属于单独的运行时能力。
- 不得将两者视为同一件事。
- 不要在 UI 迁移期间引入第二套插件加载机制。

如果原有计划要求最终支持 Component Model，应单独开展兼容性 PoC：

- Component Model 工具链。
- WIT 接口定义。
- Native Desktop 执行环境。
- Web 浏览器执行环境。
- 插件资源和权限模型。
- 可逆副作用的映射。

在运行时和安全模型未经测试前，不将它加入 Composer 产品交付依赖。

---

# 十三、实施阶段与验收顺序

| 阶段      | 交付                         | 主要验收                       |
| ------- | -------------------------- | -------------------------- |
| Phase 0 | 迁移审计和基线报告                  | 工作树和测试状态明确                 |
| Phase 1 | Lexical Vanilla Controller | 不依赖 React，原有关键测试通过         |
| Phase 2 | Dioxus 产品 UI               | 主 UI 由 Rust 实现             |
| Phase 3 | Dioxus + Lexical 集成        | IME、Selection、Clipboard 通过 |
| Phase 4 | Rust Core Adapter          | Submit → Outbox Accepted   |
| Phase 5 | IndexedDB 持久化              | 真持久化、CAS 和恢复通过             |
| Phase 6 | Dioxus Desktop             | Native Core，系统 WebView 运行  |
| Phase 7 | 全量回归                       | 跨 Host 行为一致，性能合格           |
| Future  | Pure Rust Editor           | 满足准入条件后替换 Lexical          |

必须先过 Phase 1，才允许大规模迁移产品 UI。

必须先过 Phase 3，才允许宣称 Dioxus Composer 已达到可用状态。

必须先过 Phase 4，才允许将 Dioxus 主线标记为真实 Core 接入。

---

# 十四、统一测试体系

## 14.1 测试分层

```
Rust Core Tests
     |
Bridge Conformance Tests
     |
Lexical Vanilla Tests
     |
Dioxus UI Integration Tests
     |
Browser E2E
     |
Desktop E2E
```

## 14.2 跨 Host 对拍

相同测试序列分别运行：

- Native Core。
- WASM Core。
- Dioxus Web。
- Dioxus Desktop。
- React 参考实现（迁移完成前）。

对比：

- 事件处理结果。
- Snapshot。
- revision。
- Outbox。
- Effect 状态。
- 错误结果。
- 持久化结果。

不能要求所有平台的环境 ID、时间戳和随机标识完全相同。

只比较应该一致的业务语义。

## 14.3 性能基线

以已经恢复的 React + Lexical 版本作为对照。

记录：

| 指标          | 目标                            |
| ----------- | ----------------------------- |
| 输入响应        | 不低于现有基线                       |
| 中文 IME      | 不低于现有基线                       |
| Submit      | 不出现明显回归                       |
| Snapshot 更新 | 版本顺序正确                        |
| 长文档         | 不出现明显输入卡顿                     |
| 附件混排        | 不出现明显布局和选择问题                  |
| 内存          | 记录 Dioxus / Lexical / Core 占用 |
| 初始化         | 不重复建立 Editor                  |
| Dispose     | 不泄漏订阅与任务                      |

先记录数据，再制定具体阈值。

不得无数据地宣称 Dioxus 比 React 更快，或 Rust UI 一定占用更少资源。

---

# 十五、非目标与禁止事项

本计划执行期间禁止：

1. 重写 composer-core。
2. 重写 composer-runtime。
3. 重写 plugin-api。
4. 重写 composition。
5. 改变 BM05 已冻结的协议形状。
6. 改变 BM07 CAS 语义。
7. 新建第二套 TypeScript Core。
8. 将 React 作为最终产品 UI。
9. 继续扩大 `@lexical/react` 依赖。
10. 为迁移而升级 Lexical 版本。
11. 用 Dioxus Signals 重新实现 Lexical Selection。
12. 在每次 Snapshot 更新时重建 Editor。
13. 用 JSON Base64 传输所有附件二进制。
14. 使用 Tauri 2 再包一层 Dioxus Desktop。
15. 在当前交付路径中引入 Gecko Desktop Embedder。
16. 在没有实测依据时替换 Lexical。
17. 在核心迁移中顺手重构插件架构。
18. 删除原有 React 参考资产。
19. 把未经测试的 IDB 代码视作已完成。
20. 为追求 100% Rust 而牺牲已经验证的编辑器行为。

---

# 十六、Agent 执行规则

## 16.1 每次开始任务

检查：

```
git status --short --branch
git log --oneline -20
```

检查当前阶段的依赖和历史测试。

不要按照计划文本猜测仓库实现。

以实际代码为准，报告不一致之处。

## 16.2 开发顺序

优先顺序：

1. Phase 0。
2. Phase 1 Vanilla Lexical PoC。
3. Phase 1 测试和 Go / No-Go。
4. Phase 2 Dioxus UI。
5. Phase 3 集成。
6. Phase 4 Core 接入。
7. Phase 5 持久化。
8. Phase 6 Desktop。
9. Phase 7 回归。

不得同时大规模修改编辑器、Core、Bridge 和持久化。

## 16.3 阶段提交

每个阶段形成独立提交或可审查的变更集。

建议提交顺序：

```
docs: record plan A+ migration baseline
feat: extract vanilla lexical controller
test: restore lexical browser regression suite
feat: integrate lexical island with dioxus
feat: connect dioxus composer to rust runtime
feat: complete indexeddb persistence adapter
feat: add dioxus desktop host
test: add cross-host conformance coverage
```

提交信息按照现有仓库规范调整。

没有通过测试的实现不得标记为完成。

没有用户要求时，不自动推送远端。

## 16.4 每个阶段报告

必须使用以下模板：

```
阶段：
当前 Git HEAD：
工作树状态：
修改文件：
新增文件：
删除文件：
复用资产：
新增依赖：
React 运行时依赖变化：
Lexical 版本变化：
Bridge 变化：
Core API 变化：
测试命令：
测试结果：
与基线差异：
未完成事项：
已知风险：
Go / No-Go：
下一阶段前置条件：
```

## 16.5 遇到问题

如果某个阶段不能完成：

- 不要隐瞒失败。
- 不要删除测试规避问题。
- 不要静默降级编辑器行为。
- 不要擅自修改 Core 语义。
- 提供最小复现。
- 提交问题归因。
- 优先尝试最小适配方案。

遇到明确的架构 Go / No-Go 门失败时，停在该门，交付失败原因和候选方案。

---

# 十七、Definition of Done

## 产品 UI

- Dioxus 成为产品主 UI。
- `app-web` 已升级为正式产品前端。
- 主应用布局由 Rust/Dioxus 实现。
- Composer 外围 UI 由 Rust/Dioxus 实现。
- React 不进入最终产品运行时。
- React 参考实现仍可用于必要的对照测试。

## Editor Island

- Lexical Vanilla Controller 已独立。
- 不依赖 `@lexical/react`。
- DOM 所有权明确。
- Editor 初始化和销毁可靠。
- B 系列测试逐项恢复。
- 中文 IME 通过。
- Selection 通过。
- Undo / Redo 通过。
- Clipboard 通过。
- 附件混排通过。

## Rust Core

- Core 未被重复实现。
- Runtime 原有测试通过。
- Plugin System 语义不变。
- BM05 协议形状不变。
- BM07 CAS 语义不变。
- Snapshot 一致性通过。
- Effect 生命周期正确。
- Submit → Outbox Accepted → 轮次激活通过。

## Web

- 使用真实 Rust WASM Core。
- 无本地 HTTP 回环作为最终 Core 调用路径。
- Lexical 与 Dioxus 稳定交互。
- IndexedDB 真持久化。
- 刷新和重新打开可以恢复状态。

## Desktop

- 使用 Dioxus Desktop。
- Core 直接执行 Native Rust。
- 不经 WASM 调用 Native Core。
- Lexical 在系统 WebView 中正常工作。
- Windows 中文输入法通过手工验收。
- 文件和附件功能正常。
- 资源可以正确释放。

## 架构

- 一个 Rust Core。
- 一个 Composer Protocol。
- 一个 Dioxus 产品 UI。
- 一个独立 Lexical Editor Island。
- Web WASM / Desktop Native 两种运行路径。
- Dioxus 不依赖 React。
- Rust Editor 继续作为可替换的实验方向。
- 所有历史资产和决策均可追溯。

---

# 十八、首个 Agent 任务

**不要一上来迁移整个应用。**

首先只执行 Phase 0 和 Phase 1。

交付内容：

1. 当前工作树与提交审计。
2. React / Lexical 依赖清单。
3. React Plugin → Vanilla API 映射表。
4. Vanilla Controller 最小实现。
5. Dioxus 0.7 最小挂载 PoC。
6. B 系列关键测试迁移结果。
7. 中文 IME / Selection 测试记录。
8. Go / No-Go 结论。

最小 PoC 必须完成：

```
Dioxus 页面启动
      |
创建 Lexical Island
      |
输入中文
      |
选择候选词
      |
Ctrl + Shift + 方向键
      |
获取 Editor State
      |
清空编辑器
      |
销毁编辑器
      |
重新创建编辑器
```

同时确认最终页面不依赖 React Runtime。

**Phase 1 通过后，再开始大规模将 `app-web` 发展为产品 UI。**

本项目最终方向是：

**Dioxus 负责产品，Lexical 负责编辑，Rust 负责业务。**

不重写已经可靠的浏览器编辑行为，不丢弃已经完成的 Rust 核心，也不把已经验证过的 React 产品线继续扩大为另一套长期维护的 UI 架构。

## 这份计划与上一版相比，关键改变

我确认过两个关键技术前提：

- Lexical 官方已有 Vanilla JS 使用路线，同一套 Extension 可以脱离 React 使用；各个 `@lexical/*` 包还要求版本一致，且应用应避免加载多份 Lexical Core。

- Dioxus 0.7 支持通过 `document::eval` 运行 JavaScript；Desktop 使用系统 WebView，但 Rust 代码仍在 Native 环境执行。因此 Dioxus 可以直接调用 Native Core，不必再套 Tauri 或 WASM。

我认为最重要的设计调整是：不要把 Lexical Vanilla 化误认为简单删除 React。 原来的 React Plugins 必须逐项迁移到 Vanilla Controller / Extension / Command。Phase 1 就是专门验证这件事的，不能跳过。

另外，这个方案仍有一个明确取舍：它是 Rust-first，而不是 100% Rust。若将来你的 Rust 编辑器通过同一组 IME、Selection、附件混排和撤销测试，可以只替换 Lexical Island，而不用推翻 Dioxus 或 Rust Core。

建议先让 Agent 执行文末的 Phase 0 + Phase 1 PoC，不要立即让它全仓迁移。阶段进展也可以按这份计划定期复核。
