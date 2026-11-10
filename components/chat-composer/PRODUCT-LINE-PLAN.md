# BetterHarness Composer 产品线恢复与双 Host 架构实施计划

> 编者注（2026-11-11 收编）：本文为可直接交给代码 Agent 的实施计划，按原文保留。
> 两处事实修正：基线 `main=2cbed4c` 核实无误；浏览器测试实际为 **B01–B32（34 项）**
> （文中"B20–B34"按原文保留，执行时以 verify/demo-playwright.mjs 实际清单为准）；
> "composer-runtime 已有 94 项测试"指 workspace 总数（runtime 本体 11 项 FM 对拍）。

下面这份可以直接交给代码 Agent。它不是从零重写 Composer 的方案，而是以 `main=2cbed4c` 所描述的工程状态为基线，复活已有 React + Lexical 资产、建立统一 Bridge、实现 Web WASM 和 Desktop Native 双 Host。

我特别加入了几个必须先验证的风险点：新 Rust Core 是否真的能编译为 WASM、现有 Effect 生命周期如何映射、订阅与快照如何避免竞态，以及 Lexical 的 DOM/IME 状态不能被 Rust 快照反向覆盖。

# BetterHarness Composer 产品线恢复与双 Host 架构实施计划

**项目目标：** 在不修改现有 Rust 业务核心、不丢失 Dioxus 实验线的前提下，恢复 React + Lexical Composer 产品线，建立统一的 Composer Bridge，并分别接入 Web WASM Host 和 Tauri 2 Desktop Native Host。

**工程基线：** `main=2cbed4c`（开始实施前必须核实当前 HEAD；如已变化，以实际工作树为准）。

**实施原则：**

1. Rust Core 是唯一业务逻辑源。
2. React + Lexical 是产品 UI，不承担核心业务状态机职责。
3. Web 与 Desktop 使用同一套 Bridge 语义和协议 DTO。
4. Web 使用 Rust WASM，Desktop 直接调用 Rust Native Core。
5. Dioxus `app-web` 保留为实验和架构验证线，不删除、不强制迁移。
6. `archive/ts` 是需要重新启用的历史资产，不是废弃代码。
7. 不为了增加 Rust 代码占比而牺牲已经验证过的编辑器行为。

---

# 一、目标架构

## 1.1 总体结构

```
                    BetterHarness Composer
                              |
                              |
                   React + TypeScript UI
                              |
                     Lexical Editor
                              |
                   Composer React Provider
                              |
                    Composer Bridge API
                              |
                Shared Protocol / DTO Types
                              |
              +---------------+---------------+
              |                               |
          Web Host                       Desktop Host
              |                               |
        wasm-bindgen                     Tauri 2 IPC
              |                               |
         WASM Runtime                    Native Runtime
              |                               |
              +---------------+---------------+
                              |
                     composer-runtime
                              |
                       composer-core
                              |
                  Rust Plugin / Composition
```

逻辑上只有一个 Rust Core。

物理上有两种运行方式：

- Web：Rust Core 编译为 WASM，由浏览器直接执行。
- Desktop：Rust Core 作为 Tauri 后端原生 Rust 代码直接执行。

两种 Host 不允许分别实现一套业务状态机。

## 1.2 各层职责

| 层             | 技术                                | 职责                          |
| ------------- | --------------------------------- | --------------------------- |
| Composer UI   | React + TypeScript                | 组件、布局、主题、交互                 |
| 编辑器           | Lexical                           | 输入、选区、富文本、IME、撤销、剪贴板        |
| UI Provider   | React Context / Hooks             | UI 状态订阅、组件生命周期、Bridge 注入    |
| Bridge        | Rust Protocol DTO + TypeScript 类型 | 统一事件、快照、Effect、错误协议         |
| Web Host      | wasm-bindgen                      | 调用 WASM Core，管理监听与异步交互      |
| Desktop Host  | Tauri 2                           | IPC、窗口、原生文件能力、应用生命周期        |
| Core Runtime  | Rust                              | 事件处理、状态更新、Effect 生命周期       |
| Core          | Rust                              | 台账、状态模型、业务不变量               |
| Plugin System | Rust                              | plugin-api、Fiber、可逆副作用      |
| Composition   | Rust                              | Profile / Bundle / Patch 组合 |

---

# 二、明确禁止改变的现有资产

在开始开发之前，先建立资产保护清单。

## 2.1 必须保持不变的核心

以下部分属于已有业务资产，不在本次重写范围内：

- `composer-core`
- `composer-runtime`
- `keynav`
- `completion`
- `intake`
- `reorder`
- `snapshot`
- `plugin-api`
- `composition`

当前状态：

- composer-runtime 已有 94 项测试。
- FM 系列 11 项对拍测试已通过。
- Plugin System 已基于 Rust 实现。
- Fiber / 可逆副作用机制已经存在。
- Profile / Bundle / Patch 已经存在。

Agent 必须先运行现有测试，记录基线结果。

不得为了适配 React 而修改核心状态机语义。

不得重新实现一套 TypeScript Core。

不得为了让两种 Host 使用相同调用技术而强制把 Native Core 编译成 WASM。

不得为了方便直接把 Rust 内部类型全部暴露给 UI。

## 2.2 必须保留的历史资产

`archive/ts`：

- React UI。
- Lexical Editor。
- 原有组件实现。
- 浏览器行为测试。
- B20–B34 测试与问题记录。
- IME、选区、撤销、快捷键、剪贴板等踩坑记录。

`archive/rust`：

- wasm-bindgen 导出相关实现。
- 23 项 Node 冒烟测试。
- 旧实现中的可复用绑定经验。

注意：旧版实现只能作为参考，必须逐项核对新 Runtime 的类型和语义。不能因为旧版本通过了 Node 测试，就认为新 Runtime 已经具备 WASM 兼容性。

`app-web`：

- 保留 Dioxus 0.7。
- 保留现有 WASM 编译验证。
- 保留台账真实状态接入。
- 暂时不删除现有回环传输。
- 后续可以用来验证统一协议是否真正与 UI 框架无关。

---

# 三、阶段 0：仓库勘察与基线冻结

**目标：避免在不了解现有代码的情况下重复造轮子。**

在修改任何代码之前，完成以下工作。

## 3.1 检查仓库

确认：

- Cargo Workspace 结构。
- 所有 crate 的依赖关系。
- composer-core 和 composer-runtime 的实际公开 API。
- Runtime 的事件分发接口。
- Runtime 的快照生成接口。
- Runtime 的 Effect 产生和处理机制。
- Plugin System 的实际生命周期。
- `app-web` 如何连接 Runtime。
- `archive/ts` 的完整组件结构。
- `archive/ts` 中 B20–B34 的测试组织方式。
- `archive/rust` 中 WASM 导出的实际方式。

输出：

`docs/architecture/composer-asset-inventory.md`

内容包括：

1. 当前 crate 结构。
2. 依赖关系。
3. 各层公开 API。
4. 历史 React/Lexical 组件清单。
5. 历史浏览器测试清单。
6. 可以直接复用的代码。
7. 必须适配的代码。
8. 无法复用的代码及原因。

## 3.2 运行基线测试

执行：

```
cargo test --workspace
```

以及现有 WASM、Node、浏览器测试命令。

记录：

- 测试总数。
- 通过数。
- 失败数。
- 跳过数。
- WASM 构建结果。
- 原有测试需要的浏览器和环境。

输出：

`docs/testing/composer-baseline.md`

不得把原本失败的测试悄悄从 CI 中删除。

## 3.3 WASM 兼容性检查

这是第一个技术风险门。

`app-web` 曾经编译为 wasm32，不代表当前 `composer-runtime` 和所有依赖已经支持 wasm32。

必须独立验证：

```
cargo check -p composer-core --target wasm32-unknown-unknown
cargo check -p composer-runtime --target wasm32-unknown-unknown
```

具体 crate 名称以实际 Workspace 为准。

检查：

- 文件系统依赖。
- 操作系统 API。
- 线程和同步原语。
- Tokio 等异步 Runtime 依赖。
- 动态加载。
- 插件系统依赖。
- 时间、随机数、网络等外部能力。
- 所有第三方 crate 的 WASM 支持情况。

如果失败：

1. 判断是否属于 Core 业务逻辑，还是 Host 能力。
2. 把浏览器和桌面平台相关能力隔离到 Adapter / Port。
3. Core 不得直接依赖特定操作系统。
4. 不得为 WASM 复制一套业务逻辑。
5. 不得未经评估改用本地 HTTP 服务作为最终 Web 方案。

输出：

`docs/architecture/wasm-compatibility.md`

---

# 四、阶段 1：恢复 React + Lexical 产品线

建议新建独立的 `app-react`，但必须先检查仓库现有目录和构建系统，避免与已有应用结构冲突。

## 4.1 恢复 UI

从 `archive/ts` 恢复：

- React 组件。
- Composer 主界面。
- Lexical Editor。
- 输入区域。
- 快捷键。
- Completion UI。
- 附件 UI。
- 交互状态。
- 主题和样式。
- 现有浏览器测试。

不得直接将整个 archive 目录无审查地复制到新目录。

对每个模块标注：

- 直接恢复。
- 修改 import / 接口后恢复。
- 需要适配新 Core。
- 已不再需要。

## 4.2 UI 与 Core 的状态边界

必须区分两类状态。

**Lexical / 浏览器负责的编辑器瞬时状态：**

- DOM 选区。
- 光标位置。
- IME composition 状态。
- 候选输入过程。
- 编辑器内部 Selection。
- DOM 焦点。
- 尚未完成的编辑操作。

**Rust Core 负责的业务状态：**

- Composer 台账。
- 草稿业务身份。
- Submit 状态。
- Outbox。
- 事件和事务。
- 附件业务归属。
- Effect 生命周期。
- 业务快照。

Lexical 的 DOM 和 Selection 是编辑器交互事实源，不能用 Rust Snapshot 在每次状态更新时反向覆盖整个编辑器。

严禁：

- 每次打字都用 React state 重建整个编辑器。
- 每次收到 Rust Snapshot 都重置 Lexical 内容。
- 用 Rust 快照代替浏览器实时 Selection。
- 在 IME composition 未完成时强制同步或替换编辑器文本。

UI 可以向 Core 发送必要的编辑事件，但必须尊重 Lexical 的输入生命周期。

## 4.3 必须恢复的历史问题测试

以下记录不能丢失：

1. `isMoveForward` 位掩码问题。
2. Lexical 对 `Ctrl+Shift+方向键` 不派发预期命令的问题。
3. Lexical 内部 Selection 滞后于 DOM Selection 的问题。
4. `editorState.read` 不自动设置活动 Editor 的问题。
5. IME composition 窗口。
6. 剪贴板 MIME 类型。
7. 原生拖放与粘贴。
8. Undo / Redo 行为。

原有 B20–B34 测试应尽量保留原始用例，通过 Adapter 适配新接口。

## 4.4 建立 UI Provider

建议结构：

```
app-react/
  src/
    app/
    components/
    composer/
      ComposerProvider
      ComposerContext
      ComposerHooks
      ComposerSelectors
      ComposerBridge
      editor/
      attachments/
      completion/
      keynav/
    hosts/
      web/
      desktop/
    generated/
```

具体目录允许根据现有工程调整。

组件只能依赖 Composer Provider / Hooks，不允许直接依赖：

- wasm-bindgen 导出模块。
- Tauri invoke。
- Tauri event。
- Core 内部 Rust 类型。

这样 React 组件本身不需要知道自己运行在 Web 还是 Desktop。

阶段验收：

- React 应用能够独立启动。
- Lexical 可以正常输入。
- 原有快捷键测试恢复。
- 中文 IME 测试通过。
- 选区与撤销测试通过。
- UI 尚未接入真实 Core 时可以使用受控测试 Adapter，但不得把 Mock 当成最终实现。

---

# 五、阶段 2：设计 Composer Bridge

这是本次改造最重要的基础设施。

Bridge 必须是有明确协议、有错误模型、有版本、有测试的正式边界。

## 5.1 协议类型

建议分离：

```
composer-core 内部模型
        |
        | 映射
        v
Composer Protocol DTO
        |
        +---- TypeScript 类型
        |
        +---- WASM 序列化
        |
        +---- Tauri IPC 序列化
```

不要直接把内部 Rust 结构体当作 UI API。

Protocol DTO 需要明确：

- 事件结构。
- 快照结构。
- Effect 请求结构。
- Effect 回执结构。
- 错误结构。
- 版本字段。
- 必要的标识符。

可使用：

- `serde`：协议序列化。
- `ts-rs`：导出 TypeScript 类型。
- `wasm-bindgen`：WASM / JavaScript 调用。
- 现有工程已经采用的其他序列化方式。

注意：`ts-rs` 和 `wasm-bindgen` 职责不同，不能互相替代。

## 5.2 Bridge 最小接口

建议统一成以下语义：

```
interface ComposerBridge {
  getSnapshot(): Promise<ComposerSnapshot>;

  dispatch(
    event: ComposerEvent
  ): Promise<DispatchResult>;

  subscribe(
    listener: (update: ComposerUpdate) => void
  ): Promise<UnsubscribeHandle>;

  ackEffect(
    id: EffectId,
    result: EffectResult
  ): Promise<AckResult>;

  dispose(): Promise<void>;
}
```

这里是协议草案，不要求与现有 Runtime 的函数签名完全一致。Agent 必须优先适配已有 API。

具体职责：

| 方法            | 职责                 |
| ------------- | ------------------ |
| `getSnapshot` | 获取完整业务快照           |
| `dispatch`    | 提交用户事件             |
| `subscribe`   | 订阅状态和必要的 Effect 更新 |
| `ackEffect`   | 回传外部 Effect 处理结果   |
| `dispose`     | 释放当前 Bridge 实例的资源  |

另外，订阅接口必须处理初始化竞态。

推荐语义：

```
subscribe()
   |
   +--> 原子地注册订阅
   |
   +--> 返回初始 Snapshot + revision
   |
   +--> 推送后续 revision
```

不能使用：

```
getSnapshot()
       |
       | 中间可能发生状态变化
       v
subscribe()
```

否则 UI 可能永久漏掉两者之间的状态更新。

如果现有 Runtime 已经提供原子订阅机制，直接适配，不要重新实现一套。

## 5.3 事件顺序

每个 Composer Runtime 实例必须有确定的事件顺序。

要求：

- 单实例的 Dispatch 串行处理。
- 明确定义并发 Dispatch 的排序规则。
- 必要时增加 `event_id`、`client_seq`、`instance_id`。
- Snapshot 带单调递增的 `revision`。
- UI 忽略过期 Snapshot。
- 不得因 WASM 异步调用、Tauri IPC 或 Promise 调度造成事件乱序。

具体的事件 ID 和序号设计应结合现有 Runtime 实现，不能无意义地重复引入已经存在的标识符。

## 5.4 Effect 生命周期

必须首先理解 composer-runtime 当前的 Effect 语义。

Rust Runtime 已经负责事件和效果处理，不得在 Host 重复执行 Rust 已经执行的副作用。

需要区分：

1. Rust Runtime 内部执行的 Effect。
2. 必须由 Web Host 执行的浏览器 Effect。
3. 必须由 Desktop Host 执行的原生 Effect。
4. 插件自身管理的可逆副作用。

`ackEffect(id, result)` 仅用于确实需要外部执行和回执的 Effect。

要求：

- Effect 有唯一标识。
- 重复回执不会重复提交事务。
- 同一 Effect 的冲突回执必须有确定错误行为。
- 未知或已经结束的 Effect 有确定处理规则。
- 失败结果能够被 Core 正确识别。
- 必须保留现有 Fiber / 可逆副作用语义。
- 不得由 React 自行推断和决定业务补偿逻辑。

## 5.5 Snapshot 一致性

每份 Snapshot 应明确关联 `revision`。

要求：

- revision 单调递增。
- 订阅初始化时获得基准 revision。
- 更新通知具备明确的版本。
- 过期快照不覆盖新状态。
- 恢复订阅时能够重新获取完整状态。
- 快照不能包含不应暴露给 UI 的内部资源和运行时对象。

初期优先使用完整 Snapshot，除非性能数据证明需要增量 Snapshot。

## 5.6 Dispose 语义

要区分：

- 取消 UI 订阅。
- 释放 Bridge 实例。
- 销毁 Composer Runtime。
- 处理仍在执行中的 Effect。

不要在 React 组件卸载时意外销毁需要继续工作的业务 Runtime。

必要时提供单独的 `unsubscribe`，`dispose` 只负责销毁当前实例的资源。

---

# 六、阶段 3：实现 Web WASM Host

## 6.1 目标

最终 Web 应用不依赖本地 Rust HTTP 服务。

运行结构：

```
Browser
   |
React + Lexical
   |
Composer Bridge
   |
wasm-bindgen
   |
composer-runtime.wasm
   |
composer-core
```

## 6.2 实现内容

- 新建 WASM Adapter。
- 接入 Core Runtime。
- 导出必要的 Bridge 方法。
- 导出 Protocol DTO。
- 实现 Snapshot 订阅。
- 实现 Dispatch。
- 实现外部 Effect 回执（仅限 Runtime 确实需要的 Effect）。
- 实现错误映射。
- 实现 dispose。
- 实现初始化和失败恢复。

不要把整个 Rust Core 的内部 API 无差别导出。

不要把业务逻辑放进 JavaScript WASM wrapper。

## 6.3 异步与性能

初期可以使用最简单、最可靠的调用方式。

但 Bridge 对 UI 应保持异步接口，避免以后将 Core 移至 Worker 时修改 React 组件。

如有必要，可以将纯 Core 运算移入 Web Worker，但：

- Lexical DOM 必须留在主线程。
- IME 和 Selection 仍由浏览器负责。
- Worker 迁移不能改变事件顺序。
- 不得仅为了技术形式引入 Worker。

## 6.4 WASM 验收

至少验证：

1. WASM 初始化。
2. Snapshot 获取。
3. Dispatch。
4. 事件排序。
5. Snapshot 更新。
6. Effect 输出。
7. Effect 回执。
8. 重复回执。
9. dispose。
10. 初始化失败和错误传播。

最终必须使用真实 Rust Core，不能保留一个只模拟协议的 Mock Host。

---

# 七、阶段 4：实现 Tauri 2 Desktop Host

## 7.1 目标

Desktop 不经过 WASM。

运行结构：

```
React + Lexical
      |
Composer Bridge
      |
Tauri IPC
      |
Tauri Rust Backend
      |
composer-runtime (native)
      |
composer-core
```

## 7.2 实现内容

- 创建 Tauri 2 Desktop Host。
- 接入现有 React 构建产物。
- 将 Native Runtime 注册到 Tauri 应用状态。
- 为 Composer 实例提供独立 Runtime 生命周期。
- 实现 Dispatch IPC。
- 实现 Snapshot / Update 事件推送。
- 实现必要的 Effect 回执。
- 实现 dispose。
- 实现错误序列化。

必须复用 Web Host 的 Protocol DTO 和语义。

Tauri IPC 与 WASM 调用方式不同，但 UI 不得感知这种差异。

## 7.3 并发与生命周期

必须检查：

- 多个 Composer 实例是否可能并行。
- 多个窗口是否可能访问同一 Runtime。
- Runtime 是否要求单线程。
- 是否需要 Mutex、Actor 或已有事件队列。
- 是否有异步任务在窗口关闭后仍然运行。

避免：

- 为整个 Runtime 长时间持有 Mutex。
- 在持锁期间等待外部异步操作。
- 窗口关闭后丢失尚未完成的业务事务。
- 两个窗口修改同一实例却没有确定顺序。

## 7.4 平台能力隔离

Tauri Host 可以负责：

- 文件选择。
- 文件读写。
- 原生拖放。
- 应用窗口。
- 系统通知。
- 系统剪贴板。
- 应用生命周期。

但这些能力必须以明确的 Host API 暴露，不应该直接渗透到 Composer UI 或 Core。

---

# 八、阶段 5：跨 Host 一致性测试

这是本项目的核心质量门。

不能仅仅证明 Web 和 Desktop 都能编译。

必须证明它们执行同一组事件序列时，得到相同的业务语义。

## 8.1 Bridge Conformance Tests

建立统一测试序列：

```
初始化 Composer
       |
获取 Snapshot
       |
输入事件
       |
提交 Submit
       |
Runtime 处理
       |
生成 Effect
       |
执行 / 回执
       |
Snapshot 更新
       |
检查 Outbox
```

同一测试分别运行：

- Native Rust。
- WASM Node 环境。
- 浏览器 Web Host。
- Tauri Desktop Host（适合的集成测试范围）。

比较：

- Snapshot。
- revision。
- Outbox。
- Effect 请求。
- Effect 最终状态。
- 错误结果。
- 事件处理顺序。

可以用 canonical JSON / golden fixtures 做对拍，但必须排除合法的环境差异字段，例如随机实例 ID 或时间戳。

## 8.2 必测异常场景

- 重复 Dispatch。
- 重复 Effect 回执。
- 错误 Effect ID。
- 并发 Dispatch。
- 过期 Snapshot。
- 订阅过程中发生状态更新。
- 订阅断开后重新连接。
- UI 卸载。
- Host 销毁。
- 处理中发生错误。
- 多 Composer 实例互不干扰。

## 8.3 Rust 测试

现有 94 项测试和 FM 对拍测试必须保持通过。

增加 Bridge 专属测试，优先使用现有测试工具。

适当增加属性测试，验证：

- revision 单调性。
- 重复回执幂等性。
- 事件序列一致性。
- Dispose 后资源不会继续泄漏。
- 非法输入不能破坏 Runtime 状态不变量。

---

# 九、阶段 6：浏览器和编辑器行为验证

React + Lexical 是产品线，因此不能只做 Rust 单元测试。

## 9.1 恢复 B20–B34

逐项核对 archive 中的测试：

- 原始测试目标。
- 原始浏览器行为。
- 对应现有实现。
- 新适配层是否改变了行为。
- 是否需要更新测试驱动方式。

不要把原测试删掉再声称通过。

## 9.2 中文 IME

必须覆盖：

- compositionstart。
- compositionupdate。
- compositionend。
- 中文候选词选择。
- 候选词未完成时按 Enter。
- Shift + Enter。
- composition 中的快捷键。
- 输入过程中收到 Core Snapshot。
- 输入过程中发生 React 更新。
- 快速连续输入。
- 中英文混合。
- 输入框失焦和恢复焦点。

必须注意：自动化浏览器测试不能完全代替真实操作系统输入法测试。

至少保留实际 Windows 中文输入法的手工验收记录。

## 9.3 Selection 与键盘行为

必须覆盖：

- DOM Selection。
- Lexical Selection。
- 方向键移动。
- Ctrl + 方向键。
- Ctrl + Shift + 方向键。
- Home / End。
- Shift + Home / End。
- 多段文本选择。
- 撤销 / 重做。
- 光标位置在更新后的正确性。

## 9.4 剪贴板与附件

覆盖：

- 纯文本粘贴。
- HTML 粘贴。
- 图片粘贴。
- 文件粘贴。
- 多 MIME 数据。
- 拖放文件。
- 拖放图片。
- 不支持的 MIME。
- 大文件。
- 重复粘贴。
- 附件上传失败。

文件本体不要默认通过 JSON Base64 在 Bridge 中来回传输。

优先使用平台文件对象或 Host 管理的文件句柄；Protocol 只传递必要元数据和引用。

---

# 十、阶段 7：性能与实际使用验收

先记录已有 React + Lexical 的性能基线，再与新方案比较。

至少记录：

| 指标          | 测试内容                       |
| ----------- | -------------------------- |
| 输入延迟        | 连续普通文本输入                   |
| IME 延迟      | 中文 composition             |
| Submit 延迟   | 提交到 Outbox 可见              |
| Snapshot 延迟 | Core 更新到 UI 显示             |
| 渲染耗时        | 大量消息与复杂 Composer           |
| 长文档性能       | 大量节点、长文本                   |
| 内存          | WASM / Native Runtime / UI |
| 初始化         | 首次启动和重复打开                  |
| 资源释放        | 卸载和重新初始化                   |

建议先采集基线，再设定性能回归阈值。

不得在没有数据的情况下声称 WASM 或 Native 一定更快。

## 10.1 桌面 WebView 矩阵

Tauri 的系统 WebView 并不统一：

| 平台      | WebView   |
| ------- | --------- |
| Windows | WebView2  |
| macOS   | WKWebView |
| Linux   | WebKitGTK |

至少确认目标平台实际可用的构建和测试环境。

不要仅因为 Chromium 浏览器测试通过，就认为三个平台的 IME、剪贴板、拖放完全通过。

---

# 十一、实施阶段及交付门槛

按以下顺序开发，不要同时大规模修改多个层。

## Phase 0：资产勘察

交付：

- `composer-asset-inventory.md`
- `composer-baseline.md`
- `wasm-compatibility.md`

验收：仓库结构、公开 API、测试和 WASM 兼容性已确认。

## Phase 1：React + Lexical 恢复

交付：

- `app-react`
- Composer React Provider
- 恢复的 Lexical 编辑器
- 恢复的 B20–B34 测试

验收：React + Lexical 可独立运行，IME、选区和撤销行为通过。

## Phase 2：Bridge 协议

交付：

- Protocol DTO。
- TypeScript 类型生成。
- ComposerBridge 接口。
- 事件排序机制。
- Snapshot 订阅机制。
- Effect 生命周期映射。
- Bridge 单元测试。

验收：Bridge 可以在 Mock Adapter 下完整模拟事件和快照，但 Mock 只用于测试。

## Phase 3：Web WASM Host

交付：

- WASM 构建。
- wasm-bindgen 导出。
- Web Adapter。
- 真实 Core 接入。
- Node / Browser Conformance Tests。

验收：

**真实输入 → Submit → Rust Runtime → Outbox 可见。**

不允许使用假 Core 或本地回环 HTTP 替代最终 WASM Core。

## Phase 4：Tauri Native Host

交付：

- Tauri 2 Desktop 应用。
- Native Runtime 管理。
- Tauri IPC Adapter。
- Snapshot 推送。
- Effect 回执。

验收：Desktop 不经过 WASM，且通过与 Web 相同的业务协议测试。

## Phase 5：回归与优化

交付：

- Native / WASM 对拍报告。
- B20–B34 浏览器测试报告。
- 中文 IME 测试报告。
- 跨平台 WebView 测试报告。
- 性能基线与差异报告。

验收：所有已声明的产品能力有实际测试结果，不使用"理论上支持"代替验收。

---

# 十二、目录和代码组织建议

目录名以现有 Workspace 为准，以下仅作为目标组织方式：

```
apps/
  app-react/
  app-web/                  # 现有 Dioxus，保留
  app-desktop/              # Tauri 2 Host

crates/
  composer-core/
  composer-runtime/
  composer-bridge-protocol/ # 如现有结构没有适合的协议层
  plugin-api/
  composition/
  keynav/
  completion/
  intake/
  reorder/
  snapshot/

archive/
  ts/
  rust/

docs/
  architecture/
    composer-asset-inventory.md
    composer-bridge.md
    wasm-compatibility.md
    host-adapters.md
  testing/
    composer-baseline.md
    bridge-conformance.md
    browser-ime.md
    desktop-webview.md
```

不要为了符合这个目录树而移动已有代码。

优先采用最小增量结构。

---

# 十三、明确的非目标

本轮禁止把以下事情混入主线：

1. 重写 composer-core。
2. 重写 composer-runtime。
3. 重写 Cordis 式 plugin-api。
4. 重写 Profile / Bundle / Patch。
5. 把所有 UI 组件改写为 Rust。
6. 使用 Dioxus 替代 React 产品线。
7. 使用 Blitz 替代 Lexical。
8. 开发 Gecko Desktop Embedder。
9. 引入 Electron。
10. 重新设计整套 Harness。
11. 将 Core 复制为 TypeScript 实现。
12. 为统一接口而让 Desktop 强制运行 WASM。
13. 在没有实测依据的情况下引入复杂的 Worker、Actor 或额外服务。

Gecko、Blitz 和 Dioxus 可以继续作为独立技术实验，但不进入本次产品线交付依赖。

---

# 十四、Agent 工作规则

## 14.1 开始修改之前

必须先完成 Phase 0。

如果发现本文假设与实际仓库不符：

- 不要直接按文档猜测实现。
- 先查看现有类型和调用关系。
- 优先复用现有 API。
- 在架构记录中说明调整原因。
- 选择对核心改动最小的方案。

## 14.2 开发过程中

- 每个阶段独立提交或形成可审查的变更集。
- 不修改 archive 中的原始证据，除非明确需要更新并记录原因。
- 不删除失败测试。
- 不增加重复业务逻辑。
- 不引入无必要的依赖。
- 不把 Mock 测试结果当作真实 Host 验收。
- 不为了让编译通过而弱化类型约束。
- 不在 React 组件中直接调用 Host API。
- 不在 Core 中引入 DOM、浏览器或 Tauri 依赖。

## 14.3 每个阶段结束时必须报告

```
阶段：
修改文件：
新增文件：
复用资产：
新增依赖：
核心 API 变化：
测试命令：
测试结果：
未完成事项：
已知风险：
下一阶段前置条件：
```

## 14.4 最终交付

最终至少提供：

1. React + Lexical 产品线。
2. 统一 Composer Bridge。
3. WASM Web Host。
4. Native Tauri Host。
5. 同一协议下的跨 Host 对拍测试。
6. B20–B34 恢复情况。
7. 中文 IME 验收结果。
8. 桌面 WebView 测试结果。
9. 架构说明和使用文档。
10. 明确列出的未完成事项。

---

# 十五、最终 Definition of Done

只有同时满足以下条件，才算完成本次工程任务：

- Rust Core 没有被复制成 TypeScript 业务实现。
- composer-core / composer-runtime 原有测试全部通过。
- Plugin System 与 Composition 没有发生非必要语义变化。
- React + Lexical 正常工作。
- B20–B34 历史测试已逐项复核。
- 中文 IME、DOM Selection、撤销、剪贴板通过验收。
- Composer Bridge 具有明确版本和错误语义。
- Snapshot 订阅不存在初始化竞态。
- Dispatch 顺序确定。
- Effect 回执具备幂等性。
- Web Host 使用真实 Rust WASM Core。
- Desktop Host 直接调用 Native Rust Core。
- Web 与 Desktop 使用同一套协议语义。
- 同一事件序列的 Native / WASM 对拍通过。
- Tauri 平台差异有实际测试记录。
- Dioxus `app-web` 仍然可以独立构建。
- 没有未经批准的核心重构、编辑器替换或渲染引擎替换。

**最终架构结论：一个 Rust Core、一个 Composer Protocol、一个 React + Lexical 产品 UI、两个 Host。Dioxus 保留实验线。**

本次任务的首要交付不是完整桌面应用，而是可靠地打通：

**Lexical 输入 → React Provider → Composer Bridge → Rust Runtime → Submit → Outbox Snapshot → UI 更新。**

这条链路必须先在 Web WASM 上真实跑通，再接入 Desktop Native。后续所有功能都建立在这条经过测试的链路之上。

## 我额外强调的三个技术决策

1\. WASM 兼容性必须成为早期 Go/No-Go 门。 不能把旧 `archive/rust` 的 WASM 成功经验当成新 `composer-runtime` 已经通过验证。尤其要审查 Fiber、异步任务和平台副作用的依赖边界。

2\. 不要把 Lexical 变成受控的普通文本框。 它的 DOM 选区、IME composition 和编辑器内部 Selection 有自己的生命周期。Rust 负责业务状态，不代表它应该每次都反向控制编辑器 DOM。

3\. Bridge 是协议，不是简单的函数包装。 原子订阅、事件排序、revision、Effect 幂等性、dispose 语义都需要测试。否则 Web 和 Desktop 表面上共用接口，实际可能出现不同的业务行为。

建议先让 Agent 执行 Phase 0，并提交资产清单和 WASM 兼容性报告，再进入 Phase 1。不要让它一次性完成全部阶段后才交付。

后续也可以每周按这份计划复核 Agent 的变更、测试结果和阶段验收。
