# E5 线：插件契约层（Cordis 兼容）——让"插件"跨宿主可移植

> 2026-11-14 定。背景讨论：chat-composer 的 composer-plugin-api 已按 Cordis 语义实现
> （Context/Fiber/可逆副作用/类型化事件，969 行，见 `crates/composer-plugin-api`），
> 但 **DSH 插件不能直接用**——不是语言问题（内嵌 JS 引擎是下策），而是**服务契约缺失**。
> 本线目标：把宿主服务面按 DSH 插件的心智模型显式化，先原生 Fiber 验证扩展点，再 WASM 化。

## 1. 实测：一个真实 DSH 插件的宿主依赖面（E5 调研，2026-11-14）

样本 = `dsh-deja@0.24.1`（本机已装，`profiles/desktop/node_modules/dsh-deja/`）。
manifest 形状：package.json 的 `dsh` 字段 = `{bundle: {patch: "./cordis.patch.yml"},
client: {platform: "web"}, compatibility: {"dsh": ">=0.2.0-rc.2"}}`；
装载 = cordis.patch.yml 的 `insert: [{id: deja, name: dsh-deja}]`。

**该插件实际消费的宿主服务（ctx 上取，共 6 个）**：

| 服务 | 用法 | 次数 |
| --- | --- | --- |
| `ctx.tools.register(defineTool({...}))` | 注册模型可见工具 | 6 |
| `ctx.inject(["connection", "webServer", "sessions"])` | 依赖声明（可缺失，降级） | 5 |
| `ctx.on("agent/pre-step", ...)` | 生命周期事件订阅 | 7 |
| `ctx.commands.register({...})` | 注册用户命令 | 1 |
| `ctx.systemPrompt.context({...})` | 注入系统提示上下文 | 2 |
| `config`（cordis.patch.yml 注入） | 配置读取 | — |

**关键观察**：
- 插件对缺失服务**降级不崩溃**（`try { import dsh-tools } catch {}` + `typeof ctx.inject !== "function" return`）——宿主契约是"能力可选"而非"能力必需"。
- 插件自带二进制（deja.exe）以子进程调用，**宿主只提供注册面与事件面**——重逻辑在插件侧，宿主面很薄。
- patch 层是**配置覆盖/插入**（id 定向），与代码分离。

## 2. 契约层设计（对应表）

| DSH 服务面 | composer 契约 | 现状 |
| --- | --- | --- |
| `ctx.tools.register(defineTool)` | `Commands`（register/handler/ids） | **已有**，形状一致 |
| `ctx.inject([...])` | `FiberSpec.requires: Vec<TypeId>` | **已有**（Waiting/重放语义） |
| `ctx.on(事件)` | `EventBus.subscribe<E: LiveEvent>`（Scope 登记可逆） | **已有** |
| `ctx.commands.register` | `Commands`（同上） | **已有** |
| `ctx.systemPrompt.context` | **缺** → 新增 `PromptContext` 服务（提供后注入发送前的系统提示） | E5a 新做 |
| `config`（patch 注入） | **缺** → Fiber 装载带 `config: Value`（JSON，Schemastery 同形） | E5a 新做 |
| `ctx.connection/webServer`（HTTP 面） | **缺** → 阶段二（真有插件需要 HTTP 面再做） | 缓 |
| `ctx.sessions`（会话枚举） | **不适用**（composer 无会话树；有对应需求的插件按 composer 自己的数据服务给） | 缓 |

## 3. 分阶段排期

| 编号 | 内容 | 验收 |
| --- | --- | --- |
| **E5a** | 原生 Fiber 插件 ×3 实跑扩展点：`slash-commands`（/help /clear 进 Commands）、`file-completion`（把 demo 写死的候选表改成 CompletionSource 插件）、`word-count`（Slots 挂字数统计） | 每插件原生测试 + E2E 各 ≥1 判据；Loader 装载/卸载/级联回滚断言 |
| **E5b** | 契约补全：`PromptContext` 服务 + Fiber 装载带 config（patch 同形）+ 能力降级纪律（缺服务 → 插件跳过对应功能不崩，dsh-deja 同款） | 原生测试：注入 config 生效；缺 PromptContext 时插件仍激活但功能跳过 |
| **E5c** | 服务面冻结为 WIT 契约（composer.wit）+ **WASM 插件载体**（wasmtime + wit-bindgen；插件可任何语言编译） | 一个最小 .wasm 插件（Rust 编译）经 WIT 装载进 Loader，事件订阅/命令注册全通过 |
| **E5d** | DSH 插件移植示范：挑 dsh-deja 的一个 tool（如 session-search）按契约重写为 composer 插件 | E2E：模型可见工具被注册、查询回真实数据 |

## 4. 信任与边界（诚实面）

- **进程内编译期插件**（E5a/E5b）：契约层照做，但插件与宿主同编译发布（Rust 无安全动态加载）。
- **WASM 插件**（E5c 起）：沙箱隔离白送、语言不限——"暴露一样的接口"的完全体；代价是
  host functions 边界只传 JSON（与现有 CommandHandler 的 JSON 纪律一致）。
- **不能契约化的部分**：DSH 插件直接操作宿主私有 UI/DOM 的部分（composer 的渲染层是
  Dioxus/taino，接口形状必然不同）——契约化范围 = 服务调用（tools/commands/事件/prompt/
  config），UI 焊死部分不在内。
- **不做**：内嵌 JS 引擎（为兼容背一个语言运行时，下策）；`ctx.sessions`（composer 无
  会话树，硬造是伪兼容）。

## 5. 与既有线的挂接

- E4（乐观确认）：行内写操作的在途/回滚语义是**宿主侧**纪律，与插件契约正交——插件
  发起的写操作同样走乐观确认（E4 的 PendingWrite 天然覆盖）。
- D021（场景化 executor）：`SetScenario` 已是"宿主行为可注入"的先例——E5c 的 WASM
  host functions 沿用同一注入通道。
- 上游 PR #24（taino 选区修复）：合并后插件侧的编辑器集成面（若有）随其更新。
