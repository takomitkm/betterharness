# betterharness 组件计划书：Cordis 哲学 × Rust 平台

> 本文是 components/ 下所有组件的总计划书（2026-11-12 第四次修订：**产品方向正式采纳 Plan A+——Dioxus-first 产品 UI + Lexical Editor Island + Rust Core**，Tauri 移除，React 线转参考实现；见 §9 与 chat-composer/PRODUCT-LINE-PLAN.md）。
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

第四次修订的落点：**核心层维持第一种**（Rust 自实现 Cordis，101+ 测试）；**UI 采用第一种为主**——Dioxus 升级为产品 UI（A+），React+Lexical 线降为参考实现与测试基准（复活后已验证，见 §9）。主体 Rust-first 不变。

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

## 9. 产品线定案（2026-11-12 第四次修订：Plan A+ 正式采纳）

**一个 Rust Core、一个 Composer Protocol、一个 Dioxus 产品 UI、一个 Lexical Editor Island（唯一允许的 JS 子系统）、两种运行路径（Web WASM / Desktop Native）。React 线降为参考实现与测试基准。Tauri 不再采用（Dioxus Desktop 即桌面方案）。**

- **产品 UI = Dioxus 0.7**：主布局/会话/消息列表/Composer 外围/工具栏/插件 UI 容器全部 rsx；不再以 React 作为产品前端，`@lexical/react` 运行时依赖移除。
- **Lexical Editor Island**：Lexical Vanilla JS 独立封装（Controller + Extensions + Nodes），只负责浏览器编辑能力（IME/选区/撤销/剪贴板/富文本节点），不承担业务状态。DOM 所有权纪律：Dioxus 管外层容器，Lexical 管内部编辑器 DOM，互不越界；初期不用 Shadow DOM。
- **React 线 = 参考实现与测试基准**：app-react（76 单元 + 34 浏览器 + 14 变异 + E2E 10/10）冻结为对照组与 Vanilla Controller 的参考实现，迁移完成前不删。
- **Bridge 协议不变**：BM05 形状冻结、BM07 CAS 语义冻结；Dioxus Rust Adapter 直调 Rust Runtime 但必须维持协议语义（事件含义/顺序/revision/Effect/幂等/CAS）。
- **Desktop = Dioxus Desktop**（Wry + 系统 WebView）：Native Rust Core 直调，不经 WASM；Windows 验收优先。
- **Lexical 迁移期不升级**：以仓库锁定版本的实际 API 为准，避免多份 Lexical Core。
- **纯 Rust 编辑器（editor-rs）= 未来替换目标**：准入条件 = 同一组 IME/Selection/附件混排/撤销/剪贴板测试通过 + 性能达标；届时只换 Editor Adapter。

完整执行计划（Phase 0–7、资产保护、二十条禁止项、Definition of Done、首个 Agent 任务）：[`chat-composer/PRODUCT-LINE-PLAN.md`](chat-composer/PRODUCT-LINE-PLAN.md)（已整体替换为 Plan A+）。

## 10. 施工状态（main=b386cae + 第四次修订文档 + WIP）

- 计划书（第四次修订）+ PRODUCT-LINE-PLAN.md（**Plan A+ 执行计划**，整体替换 React+Lexical 版）。
- Rust workspace：**100 项测试绿**（core 18 / keynav 11 / completion 14 / intake 8 / reorder 10 / snapshot 7 / plugin-api 7 / composition 3 / runtime 11 / attachment-tools 5 / **bridge-protocol 7**（BM05 形状冻结 + BM07 persist_revision CAS））+ release 构建；全部 crate wasm32 编译过（Go 门）。
- composer-bridge-wasm：WasmBridge 导出（snapshot/dispatch/ack/pending_count + persist_revision 待提交）；Node 冒烟 **18/18**（真实 Core 首链：Edit→Persist→Submit→Deliver→Outbox Accepted→轮次激活）。
- app-react（**React 参考实现与测试基准**，冻结）：76 单元 + 34 浏览器 + 14 变异 + 浏览器 E2E 10/10（真实 WASM Core 全链路）。
- IDB（Phase 5 输入，**未验证**）：persist.ts 适配器 + WasmEngine 接线已入库未测——按 A+ 计划 §八单独审计测试，不得视为完成。
- bridge-wasm persist_revision() 导出：未提交未验证（随 Phase 5 验证）。
- 下一步：Phase 0 迁移审计 + Phase 1 Lexical Vanilla PoC（Go/No-Go 门）。
- WASM Components 外部插件宿主（WIT/Wasmtime）：独立 PoC，不混入 UI 迁移。
