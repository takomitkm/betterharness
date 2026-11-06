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

提交记录保留本地副本，直到用户明确移除已接纳、已拒绝或已取回的记录；`unknown`、`sending`、`queued` 不允许直接遗忘。移除一条记录不删除其他草稿仍持有的附件。当前组件不创建附件预览 object URL，因此没有依赖外部 URL 生命周期的隐藏所有权。

自定义编辑器使用 `createEditorAdapter(engine)`：`capture()` 取完整快照；`apply(snapshot, expectedDraft)` 只接受同一 generation/revision 的结果，避免异步附件准备或格式化覆盖后来的输入。

## 键盘与队列

- Enter、Ctrl/Cmd+Enter：发送；在当前请求等待接纳时消费为无操作。
- 空 Enter、发送键 Repeat：不创建消息、不插换行。
- Shift+Enter / Alt+Enter：明确换行。
- IME 组合确认：交给输入法。
- 空编辑器的 Up：取回最近一条尚未派发的排队消息；有空白、附件或引用时也不覆盖。
- `queue`：完整快照入队；对应轮次结束后只派发下一条，等新轮次结束再推进。
- `steer`：向当前轮次提交；`none`：保留草稿不投递。

`endTurn(id)` 使用明确的轮次身份；迟到的结束事件不能结束另一轮，迟到的接纳也不能复活已经结束的轮次。

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
