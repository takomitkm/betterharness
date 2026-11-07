# Chat composer

一套新的 React 聊天输入组件：独立提交记录、事务持久化、完整编辑快照、稳定消息 ID，以及明确的送达状态。没有旧 hook API 兼容层，也没有用手写 React shim 验证业务行为。

它源自 ZCode 3.17.2 双回车残留问题的调查；本目录现在是可执行的新实现，不是各家 Agent 的行为复刻或性能对比。

## 行为契约

1. **可靠交接后才清空。** 正文、编辑器结构、附件 Blob 和外部引用，与后继空草稿一起写入同一事务。保存失败不清空、不发送。
2. **新草稿独立。** 每份草稿有 generation/revision；接纳、拒绝、迟到回执都不再清理或恢复当前编辑器。
3. **失败单独保留。** 明确拒绝可原样重试或主动取回编辑。已有正文、空白、附件或引用时不能被取回操作覆盖。
4. **送达不明不重发。** 超时、断连和未知异常进入 `unknown`；没有重试/恢复按钮。查询只核对原来的 ID。
5. **一条消息一个稳定 ID。** 原样重试保持 ID 和快照；取回编辑后重新提交是新消息。服务端必须按 `(scopeId, id)` 去重并提供权威回执。
6. **提交与模型运行分开。** 本地交接时短暂只读，网络等待时可写新草稿。模型运行时可选择 queue / steer / none。
7. **引用有归属。** Lexical 只维护 mention 引用，不得删除外部集成提供的引用；Undo 历史不能跨过草稿交接或会话边界。

```text
当前草稿 A
   │ 完整快照 + 新草稿，在同一个本地事务提交
   ├──────────────► 后继草稿 B（立即可编辑）
   ▼
queued ── 保存 sending 标记 ──► sending ──► accepted
                                │          rejected → 显式重试 / 取回编辑
                                └────────► unknown  → 查询原 ID
```

浏览器进程重启后，遗留的 `sending` 会变为 `unknown`，不会自动重发；恢复出的队列暂停，宿主确认当前轮次后显式继续投递。

## 文件

| 文件 | 职责 |
| --- | --- |
| `core.ts` | 框架无关的生产状态机：交接、派发、接纳、重试、查询、队列、轮次、关闭 |
| `types.ts` | 快照、提交记录、回执、宿主传输、存储与编辑器接口 |
| `store.ts` | 原生 IndexedDB 事务与 revision CAS；另有明确用于测试/临时宿主的内存实现 |
| `snapshots.ts` | 完整快照复制、只读视图与数据校验 |
| `editor-adapter.ts` | 异步编辑器适配：按 generation/revision 校验应用结果 |
| `useComposerSubmission.ts` | `useSyncExternalStore` 订阅，不在渲染或 state updater 里执行发送 |
| `ChatComposer.tsx` | 纯文本输入、附件、提交记录、失败/未知恢复入口 |
| `LexicalEditor.tsx` | 真实 Lexical 编辑器、mention token、JSON 恢复和历史隔离 |
| `key-decision.ts` | Enter/IME 仲裁：注入时钟的纯函数裁决与组合状态跟踪，「是否继续处理」与「是否拦截浏览器」两条决策分开表达 |
| `completion.ts` | 候选菜单纯状态机（零依赖）：@/slash 触发检测、查询代次守卫（纯化的 AbortController）、高亮与选择写回计算 |
| `CandidateMenu.tsx` | 候选菜单列表框：aria-activedescendant、行 mousedown 保持编辑器选区、真实 mousemove 移动高亮、外部按下关闭 |
| `intake.ts` | 文件准入纯模块（零依赖）：IntakePolicy/intakeFiles 整批与逐文件裁决、splitClipboard 粘贴路由判定、formatBytes |
| `reorder.ts` | 附件重排纯模块（零依赖）：附件序列上的移动跨度 computeMoveSpan（目标下标钳制、同位无操作） |
| `AttachmentCards.tsx` | 附件呈现：横向 rail（翻页箭头/滚轮横滚）、图片缩略图 + 灯箱、文件卡、全视口拖放遮罩；object-URL 生命周期归每个视图所有 |
| `http-transport.ts` | 示例 HTTP 绑定：完整快照、幂等键、回执查询 |
| `demo.tsx` / `demo.html` | 使用上述生产实现的交互演示，不另写一套状态机 |
| `verify/` | 核心故障测试、真实浏览器测试、临时副本变异验证与演示服务 |

## 使用

Node >= 24，React 19。核心与 IndexedDB 存储不依赖 React；Lexical 编辑器使用 `lexical` / `@lexical/react`。

```tsx
import { createRoot } from "react-dom/client";
import {
  createComposer, IndexedDbComposerStore, ChatComposer, LexicalEditor,
} from "./components/chat-composer/index.ts";

const store = await IndexedDbComposerStore.open("my-app-composer");
const engine = await createComposer({
  scopeId: "workspace-id/conversation-id",
  store,
  transport, // 必填，实现 send() 与 lookup()，见下面的协议
  busyMode: "queue",
  sendTimeoutMs: 15_000,
});

createRoot(document.getElementById("root")!).render(
  <ChatComposer engine={engine} Editor={LexicalEditor} />,
);

// 宿主的真实模型事件，不由发送 Promise 的结束推断。
await engine.beginTurn("turn-id");
await engine.endTurn("turn-id");

// 销毁宿主时取消请求；已写入的消息仍由存储持有。
await engine.close();
store.close();
```

去掉 `Editor` 属性使用纯文本编辑器。不要在每次 React render 中创建 engine；切会话应由宿主创建/关闭对应实例。不要将两个会话共用同一个 scopeId。

## 传输协议

`send(request, { signal })` 与 `lookup({ id, scopeId }, { signal })` 返回以下一种结果：

```ts
{ status: "accepted", receipt: { id, scopeId, turnId } }
{ status: "rejected", reason: "可以证明没有接纳的原因" }
{ status: "unknown", reason: "无法确认" }
```

- `accepted` 是对端可靠接纳，不是模型回复完成。回执的消息、会话、轮次身份会校验。
- 只有能证明未接纳时才能返回 `rejected`。HTTP 错误、超时、查询不到记录都不能直接等同于未发送。
- 异常默认按 `unknown` 处理。超时取消本地等待不等于撤回服务端执行。
- `request.snapshot` 含原始附件 Blob；传输层可上传并映射成宿主引用，但必须遵守同一消息 ID 的幂等契约。编辑器清空不意味着删除附件。
- `steer` 请求包含当前 turnId；宿主必须校验该轮次是否仍可接纳插话。
- 回执先到/后到、重复接纳、轮次先结束等顺序都不应修改新草稿。
- 回执本地保存失败会留下待写回执，`engine.flush()` 只重试本地写入，不重新发送消息。发送标记写入失败时，显式重试本地保存会重新启动安全的待发队列。

前端本身不能实现服务端的“恰好执行一次”；宿主必须实现持久幂等与回执查询。示例服务演示这一协议，不连接模型 API。

## 完整快照与附件

```ts
{
  text: "正文",
  document: { format: "lexical", version: 1, value: editorStateJson },
  attachments: [{ id, name, mediaType, data: blob }],
  references: [{ id, kind: "code-comment", value: { path, line } }],
}
```

正文为空但有附件/引用仍可提交。IndexedDB 保存实际 Blob 字节，不保存会在刷新后失效的 `blob:` 地址。队列、重试、取回编辑使用同一完整快照。

提交记录保留本地副本，直到用户明确移除已接纳、已拒绝或已取回的记录；`unknown`、`sending`、`queued` 不允许直接遗忘。移除一条记录不删除其他草稿仍持有的附件。预览 object URL 只活在呈现层（AttachmentCards）：每个视图按 AssetId 拥有自己的 URL，卸载或移除即释放；持久层永远只见 Blob 字节，不保存也不依赖 URL。

自定义编辑器使用 `createEditorAdapter(engine)`：`capture()` 取完整快照；`apply(snapshot, expectedDraft)` 只接受同一 generation/revision 的结果，避免异步附件准备或格式化覆盖后来的输入。

## 键盘与队列

- Enter、Ctrl/Cmd+Enter：发送；在当前请求等待接纳时消费为无操作。
- 空 Enter、发送键 Repeat：不创建消息、不插换行。
- Shift+Enter / Alt+Enter：明确换行。
- IME 组合确认：交给输入法；组合结束后 10ms 宽限期内仍按组合处理（防 Safari 把确认键再报成普通 Enter）。
- 候选菜单开启时：Enter 只确认高亮候选（不发送不换行），↑/↓ 移动高亮，Esc 关闭；pending 时 Enter 被吞掉。
- 空编辑器的 Up：取回最近一条尚未派发的排队消息；有空白、附件或引用时也不覆盖。
- `queue`：完整快照入队；对应轮次结束后只派发下一条，等新轮次结束再推进。
- `steer`：向当前轮次提交；`none`：保留草稿不投递。

`endTurn(id)` 使用明确的轮次身份；迟到的结束事件不能结束另一轮，迟到的接纳也不能复活已经结束的轮次。

## 候选菜单（@ 与 /）

富文本编辑器内置 @（`reference`）与 /（`slash`）候选菜单，候选来源由宿主提供：

```tsx
<ChatComposer
  engine={engine}
  Editor={LexicalEditor}
  completionProvider={(kind, query) =>
    kind === "reference" ? searchFiles(query) : searchCommands(query)}
/>
```

- `completionProvider(kind, query)` 返回 `{ label, insertText }[]` 或其 Promise；缺省时富文本侧也不开菜单。
- **范围（v1）**：菜单只在富文本（Lexical）模式生效。纯文本模式暂不接菜单，与附件 rail-only 是同款的不对称——textarea 保持现状；`applyPickToText` 的纯文本写回计算已就绪但未接线。
- 触发规则（对齐 DSH，v1 简化）：从光标向前扫描到最近的 @ 或 /，查询不跨空白；触发符前不能是字母/数字/下划线（邮箱、路径不算）；slash 额外排除 `//` 与 `scheme:/`。DSH 完整的带引号路径语法不在本范围内。
- **过期保护**：查询变更即换代次；旧查询的迟到结果按代次拒绝，pending 期间候选不可选、Enter 只确认菜单不发送。
- **一次选择一次 Undo**：选择写回（@ → mention token 节点 + 补尾空格；/ → 命令回显文本 + 补尾空格）在同一个 editor.update 内完成，光标落在空格之后。
- 键盘：Enter 确认高亮项（菜单裁决先于 repeat/submit）；↑/↓ 在就绪候选间循环移动；Esc 关闭且同一条目不立刻弹回；点击菜单与输入框之外关闭。组合（IME）中的按键一律先交给输入法，组合结束后的宽限窗口内同样不检测触发。

## 统一文件准入与附件呈现（选择 / 粘贴 / 拖入）

三个入口——文件选择器、富文本编辑器粘贴（`PASTE_COMMAND`）、文档级拖放——汇到同一个准入路径（`ChatComposer` 的 `runIntake` → `intake.ts` 的纯检查），策略由宿主通过 `intakePolicy` 提供（缺省不限制）：

- **整批拒绝**（先于任何添加，DSH 同款）：`maxFiles`（按已有 + 新来数量）与 `maxBytesTotal`（按已有 + 新来字节）违规时整批拒绝，`reason` 为 `too_many` / `total_too_large`。
- **逐文件拒绝**：`maxBytesPerFile` 违规（`file_too_large`）与类型不在 `allowedMediaTypes`（`unsupported_type`）只拒绝该文件，同批其余文件照常进入。取舍说明：DSH 的图片单文件大小违规也整批拒绝，但 DSH 对通用文件本就没有本地大小上限；推广到通用文件时这里选择不连坐同批文件。
- **目录**：浏览器侧用 `webkitGetAsEntry().isDirectory` 识别（目录掉落的 File 与空文件无法区分，条目 API 是唯一来源），记录名称并按 `unsupported_type` 拒绝。
- **粘贴路由**（DSH `PASTE_COMMAND` 同款）：在事件处理器内同步读 `clipboardData`（await 之后剪贴板即失效）；文件先准入，同剪贴板的 `text/plain` 原文在条目落盘后插入——一次粘贴两者并存，文件准入被拒也不吞文字。无文件的纯文本粘贴走编辑器默认路径。粘贴不经过候选菜单会话：菜单开着时文件照常准入，文本按普通输入处理并重新检测触发。
- **拖放**（DSH `installDocumentDropEvents` 同款）：document 级 dragenter/over/leave/drop，`dragDepth` 计数防止子元素穿越闪烁；dragleave 到视口边缘或 window `dragend` 兜底重置；`dropEffect` 随可用性为 copy/none；全视口遮罩只做提示（portal + `pointer-events: none` + `role=status`），不截获指针。
- **拒绝提示不阻塞发送**：最近一次准入的拒绝（名称 + 原因）以可关闭的警告列出，同批已接受的文件不受影响，发送门控仍只看内容是否非空。

**呈现**（`AttachmentCards.tsx`）：横向 rail，图片缩略图（object-URL 预览，点击开灯箱，附件被移除时预览随关）与文件卡（类型占位符/扩展名首字母、名称、扩展名 + 大小、移除）；边缘翻页箭头按滚动几何 + `ResizeObserver` 重算；滚轮只横滚 rail（非 passive、LINE/PAGE 增量归一、每格钳制、reduced-motion 降级）；新附件滚入视野，rail 重新挂载保持起始位置。

**范围与后续（宿主集成点）**：字节始终在本地，发送载荷直接携带它们，因此这里没有 DSH 的上传生命周期——`FileCard`/图片缩略图的 uploading/ready/error 状态、进度轨道、失败重试（可重试错误与明确拒绝分开）是留给真实宿主上传管线的集成点，本组件不伪造进度。粘贴文件入口目前只在富文本编辑器接线（textarea 的 paste-files 暂缓，与菜单 rail-only 同款不对称）；拖放在两种模式都可用（textarea 模式附件保持 rail-only，不进有序文档）。

## 正文中的附件节点与移动（富文本）

富文本模式把附件作为有序文档里的节点（`ComposerAttachmentNode`，DOM 带 `data-node-id`/`data-asset-id`）插在光标处；插入、移动、删除各是一次 `editor.update` = 一步 Undo。

**移动语义**（`moveAttachmentNode(editor, assetId, targetIndex)`，跨度计算在零依赖的 `reorder.ts`）：`targetIndex` 是**整篇文档附件节点序列**里的下标（0 起）——按文档顺序枚举全部附件节点，移动后该节点必须成为其中第 `targetIndex` 个。目标越界钳制到 `[0, 数量-1]`，已在目标位时无操作。落点：摘除后插到其余附件的第 `targetIndex` 个之前；目标是末位时插在最后一个其余附件之后；没有其余附件时追加到文档末尾段落。跨段落移动天然支持——锚点附件在哪个段落，节点就插到哪个段落。移动**保留节点实例**：Lexical key 与 NodeId/AssetId 不变，React 不重挂载。

**不变量：引擎不参与移动。** 移动只改有序文档里的节点顺序；outbox、`attachments` 列表（rail 的顺序）、object-URL 一概不动。新顺序经编辑器 onChange 正常回写草稿，随消息快照一起送达。

三个移动入口（同一注册的 mover，rail-only 之外都只做转发）：

- **编程 API**：宿主经 `registerAttachmentMover` 拿到入口（或直接调 `moveAttachmentNode`）。
- **rail 卡片「前移/后移」按钮**：拖动的键盘/触屏替代（DSH 无此能力，#12506 提案；芯片拖拽把手暂缓）。目标下标由文档顺序换算：当前附件下标 ± 1。
- **键盘**：光标紧邻附件节点时，Ctrl/Cmd+Shift+→ 把该节点移过后一个附件节点，Ctrl/Cmd+Shift+← 移过前一个（同方向没有更多附件时钳到端点 = 无操作）。实现是编辑器根元素上的原生 keydown 监听（经 `registerRootListener` 挂载）：Lexical 对 Ctrl/Cmd+Shift+方向键不派发 `KEY_ARROW_*_COMMAND`（其快捷键掩码把未声明的修饰键当「必须为 false」匹配），且内部选区在 composer-sync `setEditorState` 之后可能滞后于浏览器原生移动的光标，所以目标解析以 **DOM 选区为事实源**（`$domAdjacentAttachment` 把 DOM 光标邻位经 `$getNearestNodeFromDOMNode` 映射回附件节点）。与菜单（↑/↓/Esc）、Enter 仲裁、粘贴键位互不重叠；组合中的方向键属于输入法。

不对称：纯文本（textarea）模式没有有序文档，附件保持 rail-only，无移动（`registerAttachmentMover` 不注册，rail 不渲染移动按钮）。

## 本地运行与验证

```sh
cd components/chat-composer
npm ci
npm run typecheck
npm test
npm run test:browser
npm run test:mutations
npm run demo
```

浏览器测试使用已安装的浏览器：Windows 默认 Edge，可用 `CE_BROWSER_CHANNEL=chrome` 等指定；非 Windows 可提供 Playwright 已安装的 Chromium。测试只启动回环地址的隔离演示服务，并为各用例建立独立浏览器上下文，不连接真实账号/模型。

演示地址默认 `http://127.0.0.1:5179/`，`PORT` 可覆盖。故障选择包括明确拒绝、接纳后丢回执和暂扣回执。

- 核心测试调用生产核心，不重写提交逻辑。
- 浏览器测试使用真实 React StrictMode、Lexical、IndexedDB、HTTP 幂等服务和实际渲染器崩溃注入。
- 变异脚本只在系统临时副本中破坏关键行为，要求基线绿、破坏后红；源代码不被改写。
- 具体结果、已排除范围和红绿证据见 `verify/RESULTS.md` 与 `verify/FAILURE-MODES.md`。

## 存储与宿主边界

存储适配器的 CAS 必须原子地处理草稿和提交记录，失败不得部分写入。默认 IndexedDB 实现请求 strict durability。revision 冲突时保留当前窗口的未保存输入并显示错误，不静默覆盖另一窗口。

存储配额/读写失败会明确显示，用户可重试本地保存。IndexedDB 是本地持久化，不是远端备份；清除站点数据或丢失整个浏览器配置文件不在恢复保证内。没有旧版本数据迁移，未知或损坏 schema 会拒绝打开，不能覆盖原数据。
