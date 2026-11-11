# plan-a-plus-migration-inventory（Plan A+ Phase 0）

> 勘察基线：`main=b386cae` + 工作树（2026-11-12）。上承 asset-inventory.md（Phase 0 of 乙）——本文只记 A+ 增量：Lexical 版本锁定、React Plugin → Vanilla 映射、迁移接口清单。

## 1. Git 与工作树状态

- 分支：feat/textbox-interactions == main == 5e79f1c（远端已核对）。
- 已提交未验证（Phase 5 审计对象）：IDB 适配器（app-react/src/hosts/web/persist.ts）+ WasmEngine IDB 接线（e4d0768）。
- 未提交未验证：bridge-wasm persist_revision() 导出（3 行委托）。
- 本轮新增：lexical-island/（Phase 1 PoC）。

## 2. Lexical 版本锁定（迁移期不升级）

| 包 | 版本 | 说明 |
| --- | --- | --- |
| lexical | **0.36.2** | 核心 |
| @lexical/react | **0.36.2** | 仅参考实现用（产品线 A+ 后移除） |
| @lexical/plain-text | 可解析（传递提升） | vanilla 接线：registerPlainText |
| @lexical/history | 可解析（传递提升） | vanilla 接线：registerHistory + createEmptyHistoryState |
| react / react-dom | 19.3.1 | 仅参考实现 |

`package.json` 实际依赖只声明 `lexical` + `@lexical/react`；@lexical/plain-text、@lexical/history 由 @lexical/react 传递提升到顶层 node_modules——**island 需要把它们升级为直接依赖**（避免依赖传递提升的脆弱性），版本与 lexical 对齐 0.36.2。

## 3. React Plugin → Vanilla API 映射表（按锁定版本源码核对）

| 原实现（@lexical/react 或自写） | 现用法（LexicalEditor.tsx） | Vanilla 目标 | 迁移风险 |
| --- | --- | --- | --- |
| LexicalComposer | initialConfig{namespace, nodes, theme, onError} | `createEditor(config)` + `setRootElement(el)` | 低——核心 API |
| ContentEditable | data-testid=editor | 宿主提供 contenteditable div | 低 |
| PlainTextPlugin | 事件接线 + placeholder | `@lexical/plain-text` `registerPlainText(editor)` | 中——placeholder 需自管 DOM/CSS |
| HistoryPlugin | 无参 | `@lexical/history` `registerHistory(editor, createEmptyHistoryState(), delay)` | 低 |
| OnChangePlugin | —（实际用的是 registerUpdateListener） | `editor.registerUpdateListener` | 低（已是 vanilla） |
| ErrorBoundary | LexicalErrorBoundary | onError 回调 + try/catch | 低 |
| 自定义 Enter/IME 注册（13 处） | registerCommand / registerRootListener / registerUpdateListener | **原样保留**——已是 vanilla API | 零（本就是 vanilla） |
| 自定义节点 Mention/Attachment | decorate() 返回 null，DOM 在 createDOM | 原样保留（nodes 注册进 createEditor） | 零（PoC 先不含附件节点） |
| composer-sync 握手 | editorState.read + setEditorState(tags) | 原样保留（setEditorState vanilla） | 零 |
| React 组件 CandidateMenu/AttachmentCards/ChatComposer | React 渲染 | Dioxus rsx 重写（消费同一 ViewContribution/状态） | 中——A3 集成阶段 |

**关键结论**：编辑器本体（Input/IME/撤销/剪贴板/节点）迁移 = 7 个包装导入换 3 个 vanilla API + 自写 root mount；真正的重写量在**编辑器外围 UI**（菜单/卡片/壳）——它们本来就该由宿主框架渲染（A+ 架构定位）。

## 4. 迁移接口清单（island ↔ Dioxus ↔ Core）

- **Editor Island 对外**（新冻结面，带 instanceId + version）：EditorCommand（focus/clear/insert-text/set-disabled/submit-request）与 EditorEvent（ready/document-changed/submit-request/error）。
- **Composer Protocol（BM05 冻结）**：Dioxus Adapter ↔ composer-runtime——不因 island 改名改形状。
- **Core 公开 API**（不变）：Runtime.step(Event, Clock, IdGen)、ScopeState、Loader/Mountable、Profile。
- **Rust 决策权威**：keynav（decide_enter 契约）——island 内 TS 镜像实现（DOM 事件同步需求），测试向量与 Rust 同 fixtures（D008 记录双源维护决定）。

## 5. 迁移期 PoC 范围（Phase 1）

包含：createEditor + mount/setRootElement、registerPlainText、registerHistory、IME 组合根监听、Enter 仲裁→submit-request、getPlainText/getDocument/setDocument/setDisabled/clear/destroy、双重初始化拒绝、DOM 归零。

排除（记录理由）：completion 菜单（A3 集成）、附件节点与移动（附件混排=Phase 7 十.5）、剪贴板 MIME 定制（B 系列迁移时恢复）、IndexedDB（Phase 5）、Dioxus 外围 UI 全量（Phase 2）。
