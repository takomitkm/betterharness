# chat-composer —— 聊天输入框该怎么写

来源：ZCode 桌面端 v3.17.2 的「快速双击回车 → 消息已发出但输入框残留原文+换行」bug（[zai-org/feedback#1415](https://github.com/zai-org/feedback/issues/1415)）。修复过程中把"一个聊天输入框必须写对的几条规则"沉淀成了这套自包含参考实现：`useComposerSubmission.ts` 是提交状态机，`ChatComposer.tsx` 是展示壳，`demo.html` 是可以打开就玩的四实现对比页。

## 先记住唯一的时序图

```
按下 Enter ──► 受理（同步：冻结快照 + 清空编辑器 + 上锁）
                │
                ├─ 异步：发送 RPC ──► 成功/失败
                │                       │
                ▼                       ▼
        「在途窗口」结束 ◄──────────── 结算
```

**在途窗口 = 受理到结算之间**，短则几十毫秒（本地 IPC），长则数秒（远程模型/弱网）。所有 bug、所有模式差异都在这个窗口里。

## 五条规则（每条都对应一个真实踩过的坑）

| # | 规则 | 不这样会怎样 |
|---|---|---|
| ① | 「是否在途」「编辑器当前内容」用 **ref** 读，不用 state | 事件处理器读到的是旧值：快速双击的第二下看到"不在途"，防重复提交直接失效 |
| ② | **受理即清空**：冻结快照、清空编辑器、上锁，三者必须在**同一同步块**、第一个 `await` 之前完成 | 清空拖到发送结算之后，在途窗口里编辑器还是"刚发出的正文"——第二次 Enter 就会作用于它 |
| ③ | 提交在途时，Enter（裸键和 Ctrl/⌘+）**一律消费成 no-op**，绝不放行 | 放行 = 编辑器插换行；换行又会让"结算时清空"的门禁失效 → **已发正文 + 换行永久残留**，并被当草稿落盘 |
| ④ | 失败恢复：只有编辑器**仍是空**才把快照搬回去；用户已写新内容就绝不覆盖，失败项单独保留 | 失败时无脑 setText 会吃掉用户刚写的新草稿 |
| ⑤ | IME 组合中（`isComposing`）不拦截 Enter；Shift+Enter 放行为换行 | 中文用户回车确认候选时误发消息 |

ZCode 3.17.2 的 bug 就是①③②三条叠加：提交在途 → Enter 被放行 → 插换行 → 换行推进内容版本 → 结算门禁（"期间无编辑才清空"）跳过清空 → **消息已发出，正文却留在了输入框**，还会被持久化成草稿。

## 四家实现对比（同一个窗口，四种处理）

| 场景 | ZCode 3.17.2 | ZCode 修复版 | DSH | Codex | Claude Code |
|---|---|---|---|---|---|
| 在途时草稿在哪 | 留在编辑器 | 已清空（进快照） | 留在编辑器 | 已清空 | 已清空 |
| 在途时编辑器可编辑吗 | ✅ 可编辑 | ✅ 可编辑 | ❌ 只读锁定 | ✅ 但已空 | ✅ 但已空 |
| 在途按 Enter | 插换行 → 残留 | no-op | no-op（物理锁） | 空 Enter no-op | 空 Enter no-op |
| 空闲时何时清空 | 结算后 | 受理时 | Host 受理时 | 受理时 | 受理时 |
| 模型生成中按 Enter | 排队 queue | 排队 queue | 排队 queue | steer | 排队 queue |

要点：**"不残留"的关键不是把 Enter 吞掉，而是受理时就把正文搬出编辑器**——编辑器空了，第二次 Enter 自然是无害的空 Enter。吞 Enter 只是双保险。Codex/DSH/Claude Code 三家都这么做；ZCode 3.17.2 是唯一"不清空 + 可编辑 + Enter 转换行"三条件全占的。

## 文件

| 文件 | 内容 |
|---|---|
| [`useComposerSubmission.ts`](./useComposerSubmission.ts) | 提交状态机 hook：Enter 语义、在途锁、受理即清空、失败恢复。零依赖。 |
| [`ChatComposer.tsx`](./ChatComposer.tsx) | 展示壳：textarea + 失败项提示 + 发送按钮。React 19，无其他依赖。 |
| [`demo.html`](./demo.html) | 双击打开就能玩的对比页：四种实现（ZCode 修复版 / ZCode 原版 / Codex / Claude Code）+ 可调时序 + 事件日志。27 项自动化断言全部通过。 |

## 用法

```tsx
import { ChatComposer } from "./components/chat-composer/ChatComposer.js";

<ChatComposer
  placeholder="给 Agent 派活…"
  onSubmit={async (text) => {
    await agent.send(text);   // 抛错 = 发送失败，正文会自动回到编辑器
  }}
/>
```

需要 mention / 斜杠命令 / 富文本时，把 textarea 换成 Lexical（ZCode 的做法）——键盘语义和提交状态机不需要任何改动，这也是把它们抽成独立 hook 的原因。

## 验证记录

- `demo.html`：27 项 Playwright 断言（四种模式 × 双击/排队/失败恢复/Shift+Enter），真实 Edge 全部通过
- 真实 ZCode 应用（fork [`full-handoff` 分支](https://github.com/takomitkm/ZCode/tree/full-handoff)，[`250e6ed8`](https://github.com/takomitkm/ZCode/commit/250e6ed8)，diff 见 [compare](https://github.com/takomitkm/ZCode/compare/a9fe401...250e6ed8)）：新增用例 2 passing；官方结算套件 CST01–05 5 passing 无回归；两次变异校准分别命中"清空契约"与"Enter 契约"

## 还没做（扩展点）

- **模型生成中的排队/插话**：ZCode 走 `inputRouting`（queue/guide），Codex 是 Enter=steer、Tab=queue，Claude Code 入队后 `↑` 取回。demo.html 里有演示，hook 未实现。
- **草稿持久化**：ZCode 会把没发完的草稿落盘并在重开会话时恢复；恢复时记得和"已发送正文"区分开（否则会像原 bug 一样复活已发内容）。
- **富文本**：mention / 斜杠命令建议直接上 Lexical，`$getPromptMarkdown()` 取纯文本交给本 hook 即可。