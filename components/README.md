# betterharness 组件计划书：Cordis 哲学 × Rust 平台

> 本文是 components/ 下所有组件的总计划书（2026-11-11 第二次修订：**Cordis 设计思想放到架构中心**；第三次修订：**产品线定案——React + Lexical 产品 UI + 双 Host**，见 §9）。
> 许可证：仓库已切换为 **GPL v3**（2051fdd），本目录全部组件按同一许可证发布。

结论先行：

- **Cordis 是插件运行时和服务协作框架；Rust + WASM 是跨语言、跨运行环境的组件执行方案。它们不是竞争关系，可以组合。**
- Cordis 真正解决的，是之前方案最薄弱的一环：**动态组合之后，怎样可靠地管理依赖、状态和生命周期。**
- 不预设 TypeScript 是插件主体，也不预设所有插件必须是 WASM；采用 Rust 重实现 Cordis 模型（Dioxus + Rust 自实现），保留 Context、Service、Inject、Fiber、Reversible Effects 核心模型。

核心追求的三个能力，Cordis + Rust 组合全部覆盖：

1. 组件可以细粒度拆分和复用。
2. 用户可以通过插件重新组合、替换、卸载，**而且不需要改动核心程序**。
3. 同一套实现可以运行在不同操作系统和设备上。

## 1. Cordis 真正优秀的地方

不只是普通依赖注入容器。值得借鉴的机制：

| 机制 | 作用 | 对本项目的价值 |
| --- | --- | --- |
| Context | 提供统一的服务访问环境 | 降低组件之间的直接依赖 |
| Service | 声明和提供能力 | 实现细粒度组件替换 |
| inject | 声明服务依赖 | 自动处理依赖关系 |
| Fiber | 管理插件实例生命周期 | 动态安装、卸载、重新加载 |
| Typed Events | 类型化事件通信 | 解耦组件之间的协作 |
| Disposable Effects | 自动回收注册产生的副作用 | 防止热卸载后的残留 |
| Loader | 加载和管理插件 | 动态组合系统 |

### 两个特别值得注意的机制

**第一：依赖响应式激活。** 插件 A 依赖服务 B（`inject: [service B]`）时：B 不存在，A 不崩溃，处于等待状态；B 出现，A 自动激活；B 被替换或移除，A 的相关实例回滚；新的 B 出现，再重新激活（Koishi 官方文档明确描述）。

**第二：可逆副作用。** 插件注册的事件监听器、命令、定时任务、服务、UI 扩展，卸载时统一回收；直接通过外部 API 创建的资源（如自行启动的服务器）仍需插件自带清理逻辑。

这两个机制结合，插件就能真正动态改变一个运行中的系统，而不只是启动时加载几个扩展包。

## 2. DSH 为什么比普通插件系统更值得研究

DSH（fcc0ad4）不只是用 Cordis 加载插件，而是**把整个产品设计成插件组合**：模型适配器、工具注册中心、会话日志、Agent 接口与 Agent Loop、System Prompt 组装、存储与执行策略——没有一个需要随意修改的特权核心，每个能力都可以通过配置替换。其扩展系统（packages/extensions）还实现了 cordis-host-runner / cordis-client-runner 双半动态插件与沙箱生命周期。

### A. Capability Seam：能力接缝（最值得借鉴）

一个能力分三个角色：

```
Service Definition   定义能力接口，例如 ShellExecutor
Provider A           本地 Shell
Provider B           沙箱 Shell
Consumer             使用 ShellExecutor，不关心具体实现
```

原本 `shell::execute(command)` 的直接调用，变成 `executor.execute(command)`——用本地执行器、容器执行器还是远程执行器，由配置决定。不改 Agent、不改工具调用逻辑，直接替换执行环境。这正适合细粒度、可替换、通用化内核的追求。

### B. Profile + Bundle + Patch：分层组合

用户在不修改上游源码的情况下改变整个系统：

```
Base Profile → Bundle A → Bundle B → Profile Patch → User Patch → CLI Override
```

后续层通过**稳定 ID** 替换已有配置项，也可以新增配置项。比单纯插件注册更强：不只允许添加功能，还允许**重新决定系统由什么功能组成**（例如换掉 storage / text-parser / agent-loop 的具体实现，而不必 fork 整个项目）。

### C. Durable Events 与 Live Events 分离

- **Session Events（持久事实）**：用户消息、模型输出、工具执行结果——进入可恢复的会话日志；
- **Agent Events（运行时事件）**：Agent 开始一步、请求工具、继续执行——用于实时协作和拦截。

避免把事件总线误当成数据库，也避免插件卸载后丢失重要会话记录。

## 3. Cordis 和 Dioxus 怎样结合

| 组合 | 优点 | 缺点 |
| --- | --- | --- |
| **Dioxus + Rust 自实现 Cordis 模型**（核心层选定） | 全 Rust、类型统一、运行时统一 | 需要自己实现插件机制 |
| Dioxus + 原版 TS Cordis | 可用 Cordis 插件生态 | 双语言双运行时桥接 |
| TS UI + Cordis + Rust Core | 生态成熟 | 主体不是 Rust-first |

第三次修订的落点：**核心层维持第一种**（Rust 自实现 Cordis，已落地 94 测试）；**UI 适配层采用第三种**——React + Lexical 作为产品线 Provider（复活 archive/ts 资产，见 §9），Dioxus app-web 保留为实验线。主体仍 Rust-first：业务核心、插件体系、运行时全部 Rust，UI 只做适配。

**不要重新发明 Cordis 的全部设计，复用它的设计思想：**

| Cordis 概念 | Rust 体系对应设计 |
| --- | --- |
| Context | Service Context |
| Service | Trait / Capability Interface |
| inject | Dependency Resolver |
| Fiber | Plugin Instance / Lifecycle |
| Disposable Effects | RAII / Cancellation / Disposer |
| Typed Events | Typed Event Bus |
| Loader | Plugin Loader |
| Bundle | Component Bundle |
| Profile | Runtime Profile |
| Patch | Composition Overlay |

用 Rust 的 RAII、所有权和取消机制管理插件资源；外部 WASM 插件通过稳定的跨语言接口调用 Rust 能力。

## 4. 最终架构

```
Cordis-inspired Rust Platform

┌─────────────────────────────────────────────┐
│ Dioxus UI                                    │
│ Chat / Editor / Views / Layout / UI Slots    │
├─────────────────────────────────────────────┤
│ Composition Runtime                          │
│ Context / Services / Dependency Resolver /   │
│ Fiber / Event Bus —— Cordis 式生命周期        │
├──────────────────────┬──────────────────────┤
│ Native Plugins        │ Dynamic Plugins       │
│ Rust Crates           │ WASM Components       │
├──────────────────────┴──────────────────────┤
│ Capability Runtime                           │
│ Chat / Agent / Editor / Storage / Network /  │
│ Model / Search —— 每个能力都有                │
│ Definition / Provider / Consumer             │
├─────────────────────────────────────────────┤
│ Platform Adapters                            │
│ Web / Windows / Linux / macOS / Android / iOS│
└─────────────────────────────────────────────┘
```

**分离规则**：插件管理、功能组合、UI 组件注册、能力实现必须是不同概念。插件可以同时提供一个搜索服务和一个 UI 面板，但不意味着两者绑定——UI 可以换，搜索引擎也可以换。避免插件越写越大，最后变成不可拆解的功能包。

### 三种自定义层次

| 层次 | 实现形式 | 是否需要重新编译主程序 |
| --- | --- | --- |
| 组件重组 | Profile / Bundle / Patch（TOML/RON） | 不需要 |
| 业务插件 | Rust → WASM Components | 不需要 |
| 深度原生扩展 | Rust crate | 通常需要 |

## 5. Cordis 的边界

| 问题 | Cordis 是否解决 |
| --- | --- |
| 插件依赖关系 | 解决 |
| 插件动态卸载 | 解决 |
| 生命周期管理 | 解决 |
| 服务动态替换 | 解决 |
| 插件配置重组 | 解决 |
| 原生代码安全隔离 | 不解决 |
| 跨语言 ABI | 不解决 |
| 跨平台编译 | 不解决 |
| 高频计算性能 | 不负责 |

Koishi 的大量插件实践验证了 Cordis 的**架构模式**，不代表 Koishi 插件能直接装在 DSH 或本项目的宿主上——它们依赖不同的服务接口和宿主能力。

## 6. 五条原则

1. 借鉴 **Cordis**：一切能力都通过插件、服务和依赖关系组织。
2. 借鉴 **DSH**：一切系统配置都可以通过 Profile、Bundle、Patch 重组。
3. 借鉴 **Rust**：用 Trait、生命周期和 RAII 保证核心组件可靠性。
4. 借鉴 **WASM Component Model**：定义跨语言、跨平台的动态插件接口。
5. 采用 **Dioxus**：负责跨平台 UI，不让 UI 框架侵入业务核心。

值得优先阅读：DSH 官方架构文档；Koishi Cordis 服务与依赖；Koishi Cordis 生命周期；DSH 插件模型与 Capability Seam。

## 7. Dioxus 平台矩阵（渲染路线不早定死）

| 平台 | 编译方式 | 渲染方式 |
| --- | --- | --- |
| Web | Rust → WASM | 浏览器 DOM |
| Windows / Linux / macOS | Rust 原生二进制 | 系统 WebView |
| Android / iOS | Rust 原生二进制 | 系统 WebView |

Dioxus Native（WGPU 独立渲染）仍标注实验性，不当成必须依赖。对话界面与编辑器先做性能原型：输入延迟、中文 IME、流式 Markdown、长文档虚拟化、滚动性能、插件开销。GPUI（Zed）作为编辑器交互研究参照，Slint 作为资源受限场景备选。

## 8. chat-composer：旧实现的功能搬迁矩阵

旧 TS 实现（archive/ts，76 单元 + 34 浏览器 + 14 变异全绿）已实现功能的落点：

| 已实现功能 | 旧位置（archive/ts） | 新位置 |
| --- | --- | --- |
| 可靠提交：持久 outbox、unknown 永不自动重发、queue/steer/none、逐条取回 | core.ts + core-rs | `composer-core`（台账）+ `composer-runtime`（事件/效果协议） |
| Enter/IME 仲裁 | key-decision.ts | `composer-keynav` |
| @// 候选菜单 | completion.ts | `composer-completion` + 来源注册服务（≈ registerSource） |
| 统一文件准入 | intake.ts | `composer-intake` |
| 正文附件插入/移动/撤销 | reorder.ts + LexicalEditor | `composer-reorder` + UI 层 |
| 有序文档与身份校验 | snapshots.ts | `composer-snapshot` |
| 附件卡片（alt/压缩原图/MIME 克隆） | AttachmentCards.tsx | 内置插件 attachment-tools（槽位贡献） |
| 可见队列 dock | ChatComposer.tsx | app-web（Dioxus 面板） |
| 富文本与粘贴/拖放 | LexicalEditor.tsx | app-web 平台适配层 |
| IndexedDB CAS / HTTP 回执 | store.ts / http-transport.ts | Storage/Transport 能力接缝（Definition/Provider/Consumer） |

**Durable/Live 对应**：outbox 与回执 = Session Events（持久事实，进 Storage）；泵送/派发/超时 = Agent Events（运行时事件，Live）。runtime 的事件/效果协议（Event 进 / Effect 出）就是这条边界。

## 9. 产品线定案（2026-11-11 第三次修订）

**一个 Rust Core、一个 Composer Protocol、一个 React + Lexical 产品 UI、两个 Host。Dioxus 保留实验线。**

- **产品 UI = React + Lexical**（适配层，不是核心）：Lexical 是唯一被真机锤过的富文本编辑器——我们实测抓出的三个深坑（isMoveForward 掩码不派发 Ctrl+Shift+方向键、内部选区滞后于 DOM 选区、editorState.read 不设活动编辑器）连同 B01–B32 浏览器测试一起封存在 archive/ts，复活即复用，不换编辑器重踩。原则 5 不受影响：不让 UI 框架**侵入业务核心**——React 是适配层 Provider，Cordis 核心与 Capability Runtime 不动。
- **一个 Bridge 协议**：Rust Protocol DTO（serde + ts-rs 导出 TS 类型）+ wasm-bindgen（Web）与 Tauri 2 IPC（Desktop）共用同一语义。Bridge 是协议不是函数包装：原子订阅（订阅即返回基准 revision，防初始化竞态）、Dispatch 串行定序、Effect 幂等回执、dispose 语义，全部要测。
- **两个 Host**：Web = composer-runtime 编译 WASM（wasm-bindgen）；Desktop = Tauri 2 后端直接跑 Native Rust Core。同一事件序列跨 Host 对拍（conformance tests）是核心质量门；不许为统一接口让 Desktop 强制跑 WASM。
- **状态边界铁律**：Lexical 的 DOM 选区 / IME composition / 编辑器内部 Selection 是编辑器交互事实源，Rust 快照不得反向覆盖编辑器 DOM（严禁每次收到 Snapshot 重置 Lexical、严禁 IME 未完成时强制同步）——这条纪律与 archive/ts 的 composer-sync 握手、DOM 选区事实源一脉相承。
- **WASM 兼容性 = Go/No-Go 门**：archive/rust 的 wasm 经验不代表新 runtime 通过验证，composer-runtime 必须独立过 `cargo check --target wasm32-unknown-unknown`（先查 Fiber/EventBus 的 Mutex/TypeId 边界）。

完整实施计划（Phase 0–7、资产保护清单、非目标、Definition of Done）：[`chat-composer/PRODUCT-LINE-PLAN.md`](chat-composer/PRODUCT-LINE-PLAN.md)。

首要交付链路：**Lexical 输入 → React Provider → Composer Bridge → Rust Runtime → Submit → Outbox Snapshot → UI 更新**，先在 Web WASM 真实跑通，再接 Desktop Native。

## 10. 施工状态

- 计划书（本文，第三次修订）+ 实施计划（PRODUCT-LINE-PLAN.md）。
- archive/{ts,rust}：旧实现封存（ts 侧 React+Lexical 资产待产品线复活）。
- composer-core / composer-{keynav,completion,intake,reorder,snapshot}：细组件已落地。
- composer-plugin-api：**Cordis 式 Composition Runtime**——Context 服务容器（trait 对象能力接缝）、Loader+Fiber 生命周期（依赖缺席挂起等待、能力恢复自动激活、级联回滚）、Scope 可逆副作用（LIFO Disposer）、Typed Event Bus（Live）。诚实缺席语义：激活闭包 FnOnce 一次性，级联回滚 = Retired 终态 + 宿主重新 mount，不伪造可重放。
- composer-composition：**Profile + Bundle + Patch 分层**（replace 稳定 ID 换 Provider、disable 禁用保留装载、层叠顺序覆盖）。
- composer-runtime：事件/效果引擎（Event 进 / Effect 出，顺序即契约），FM 系列 11 项对拍测试移植全绿。
- 门禁：cargo test --workspace **94/94 绿** + release 构建 + app-web wasm32 编译验证（main=2cbed4c）。
- 产品线（app-react + Bridge + 双 Host）：按 PRODUCT-LINE-PLAN.md 执行，Phase 0 资产勘察与 WASM 兼容性门先行。
- app-web（Dioxus 实验线）：保留，接 runtime 真引擎待做（回环传输暂留）。
- WASM Components 外部插件宿主（WIT/Wasmtime）：产品线之后，协议已以 trait 定形。
