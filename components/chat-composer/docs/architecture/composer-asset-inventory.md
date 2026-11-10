# composer-asset-inventory（Phase 0 资产勘察）

> 勘察基线：`main=4fc2b58`（2026-11-11）。本文是 PRODUCT-LINE-PLAN.md Phase 0 的第一份交付，供 Phase 1–3 直接引用。

## 1. Cargo Workspace 结构与依赖关系

```
chat-composer/                      ← workspace 根（members = ["crates/*", "plugins/*"]）
├── crates/
│   ├── composer-core/              台账：ids（MessageId/AttemptId/GenerationId/TurnId/ScopeId + Status/Delivery/DeliveryResult）
│   │                               + state（ScopeState：edit/handoff/begin_next/settle/begin_turn/end_turn/retry/restore/remove）
│   │            ↑ 被依赖：composer-runtime
│   ├── composer-runtime/           事件/效果引擎：Event 进 / Effect 出（step）；FM01–FM23 纪律；busyEnter 策略
│   ├── composer-keynav/            Enter/IME 仲裁：decide_enter + ImeTracker（IME_GRACE_MS=10）
│   ├── composer-completion/        @// 触发检测 + CompletionSession（代次防过期）+ apply_pick_to_text
│   ├── composer-intake/            intake_files（整批/逐文件策略）+ split_clipboard + format_bytes
│   ├── composer-reorder/           compute_move_span + apply_move_span（移动跨度纯数学）
│   ├── composer-snapshot/          validate_json / document_attachment_nodes / document_without_attachment / validate_document
│   ├── composer-plugin-api/        Cordis 运行时：Context 服务容器（trait 对象能力）+ Loader/Fiber（响应式激活、
│   │                               级联回滚）+ Scope 可逆副作用 + EventBus（Live）+ Commands/Slots/CompletionSources 内建服务
│   ├── composer-composition/       Profile/Bundle/Patch 分层：parse/effective_load（replace）/compose（disable+order）/apply_profile
│   └── composer-runtime            （见上）
├── plugins/
│   └── attachment-tools/           内置插件样板：Mountable → mount(Loader) → 命令+槽位贡献+候选来源
├── app-web/                        Dioxus 0.7 实验面板（独立 workspace；依赖 core+keynav）
├── archive/ts/                     React+Lexical 产品 UI 资产（待复活）
├── archive/rust/                   旧 wasm-bindgen 导出参考（wasm.rs：ComposerCore 门面，23 项 Node 冒烟测试）
└── PRODUCT-LINE-PLAN.md            实施计划
```

依赖图（产品线相关）：

```
attachment-tools → composer-plugin-api → (serde_json)
attachment-tools → composer-reorder
composer-runtime → composer-core
composer-composition → composer-plugin-api
app-web → composer-core, composer-keynav
```

无循环依赖；workspace 外部依赖仅 serde/serde_json/toml（全部 wasm32 验证过，见 wasm-compatibility.md）。

## 2. 产品线要接的实际公开 API（Phase 2 Bridge 的映射面）

**composer-core::state::ScopeState**（Bridge Snapshot 的来源）：
- `new(scope, generation)` / `edit(Snapshot)` / `handoff(message, next_generation, delivery, now_ms) -> Result<MessageId, LedgerError>`
- `begin_next(attempt) -> Option<(MessageId, AttemptId, Delivery, Option<TurnId>)>` / `settle(id, attempt, DeliveryResult)`
- `begin_turn / end_turn / retry / restore(id, next_generation) / remove`
- 字段：`draft`（generation/revision/snapshot）、`submissions`（Vec<Submission>，含 status/attempt/snapshot）、`active_turn`、`finished_turns`
- **注意**：`revision` 在 ScopeState（持久化单位），Draft 另有 `revision`（编辑版本）。Snapshot 字段 = text + attachment_ids + reference_ids（**无有序文档**——archive/ts 的 document/attachments Blob 语义待 Bridge 层映射，见 §4）。

**composer-runtime::Runtime**（Bridge Dispatch 的目标）：
- `restore_from_persisted(config, state)`（FM09：sending→unknown）/ `step(Event, &dyn Clock, &mut dyn IdGen) -> Vec<Effect>`
- `Event`：Edit{snapshot}/Submit/SetBusyMode/Persisted{ok}/DeliverResult/AttemptTimeout/LookupResult/BeginTurn/EndTurn/Restore/Retry/Remove/Flush/Resume/Close
- `Effect`：Persist(ScopeState)/Deliver/ScheduleTimeout/CancelTimeout/Lookup/CancelAllLookups（`PartialEq`，顺序即契约：Persist 先于同批 Deliver）
- 瞬时状态查询：is_admitting/is_paused/is_closed/busy_mode/pending_receipt_count
- **宿主必须实现**：`Clock`（now_ms）与 `IdGen`（next_id）——Bridge 层注入。

**composer-plugin-api::Loader**（产品线插件宿主入口）：
- `mount(FiberSpec, apply) -> Result<FiberId, String>` / `retire(id)` / `provide::<T>(Arc<T>)` / `remove::<T>()`
- `Scope`：provide/on_dispose/subscribe/commands()/slots()/completion_sources()/capability::<T>()
- `Mountable` trait（插件入口）与 attachment-tools 样板。

**composer-composition::Profile**（组件重组清单）：
- `parse(TOML)` / `effective_load()`（replace 解析）/ `apply_profile(loader, profile, lookup)` / `compose(slots, profile) -> CompositionPlan`

## 3. archive/ts 组件清单（Phase 1 恢复对象，逐项标注）

| 文件 | 内容 | 处置 |
| --- | --- | --- |
| `core.ts`（421 行） | TS 引擎（提交/泵送/dispatch/query/flush） | **不再需要**——语义已 1:1 移植进 composer-runtime（FM 对拍）；Bridge 直接驱动 Rust Runtime |
| `store.ts` | IndexedDB CAS | **需适配**——Bridge Persist Effect 的 Web Host 执行体；CAS 语义（revision 比对）保留 |
| `http-transport.ts` | HTTP 绑定 + 回执查询 | **需适配**——Bridge Deliver/Lookup Effect 的执行体 |
| `key-decision.ts` | Enter/IME 仲裁 | **不再需要**——composer-keynav 取代；UI 只调 decide_enter 绑定 |
| `completion.ts` | 候选会话 | **不再需要**——composer-completion 取代；CandidateMenu.tsx 改绑 |
| `intake.ts` | 文件准入 | **不再需要**——composer-intake 取代（WASM 边界传 FileMeta） |
| `reorder.ts` | 移动跨度 | **不再需要**——composer-reorder 取代 |
| `snapshots.ts` | 文档校验 + Blob/structured-clone | **部分复用**——Blob 校验属 JS 侧（Rust snapshot crate 管不了 Blob）；文档节点校验已移植 |
| `types.ts` | AssetId/Attachment/ComposerSnapshot | **需适配**——Attachment 含 Blob 与 alt/sendAsFile，Bridge 协议只传元数据+引用（文件句柄留 JS 侧，PRODUCT-LINE-PLAN §9.4） |
| `editor-adapter.ts` | 草稿→编辑器同步守卫 | **直接复用思路**——composer-sync 握手（generation/revision 比对）语义保留 |
| `useComposerSubmission.ts` | React 订阅 hook | **重写**——变为 ComposerProvider 订阅 Bridge（useSyncExternalStore 模式保留） |
| `LexicalEditor.tsx`（762 行） | 富文本编辑器全套 | **直接恢复**——含全部实测深坑修复（DOM 选区事实源、rootListener 原生 keydown、MIME 剪贴板、握手防覆盖）；onChange→Event::Edit 映射待接 |
| `ChatComposer.tsx`（346 行） | 组合壳 + 拖放 + 队列 dock | **修改 import 后恢复**——engine 调用点全部改为 Bridge dispatch |
| `AttachmentCards.tsx`（288 行） | 卡片/灯箱/移动按钮 | **修改 import 后恢复**——alt/原图开关改经插件命令（attachment-tools） |
| `CandidateMenu.tsx`（90 行） | 菜单列表框 | **修改 import 后恢复**——数据源改经 CompletionSources 服务 |
| `demo.tsx` / `demo.html` | 演示宿主 + 样式 | **需适配**——变为 app-react 的开发宿主 |
| `verify/demo-playwright.mjs` | B01–B32 浏览器测试（34 项） | **直接恢复**——engine 注入点（composerTest）改指 Bridge；用例主体不动 |
| `verify/core.test.ts` 等 8 个单元测试文件 | 76 项单元测试 | **大半不再需要**——被 Rust 测试取代；保留的=Blob/structured-clone JS 侧校验 |

## 4. 已识别的语义缺口（Bridge 层必须解决，Core 不改）

1. **有序文档与 Blob**：Rust Snapshot 只持 attachment_ids（字符串），TS 侧有完整 Lexical 文档 JSON + Blob 字节。映射方案：Bridge Snapshot 携带 `document_json`（不透明 JSON，经 serde_json::Value）+ attachments 元数据；Blob 留 JS 侧 WeakMap（AssetId→Blob），发送载荷由宿主组装——与 archive/ts「字节始终在本地」纪律一致。**Core 不感知 Blob**（计划书禁止改 Core）。
2. **admitting 窗口的 UI 反馈**：Runtime 是同步 step，admitting 在 Persist 执行前后翻转；Bridge 需要把 Persist 效果的异步执行与 admitting 状态推送给 UI（archive/ts 的 admitting→readOnly 语义保留）。
3. **Effect 回执配对**：Deliver/ScheduleTimeout 需要 attempt 级配对（CancelTimeout 在结果先到时发）；Bridge ackEffect 按 (id, attempt) 回填 `Event::DeliverResult`/`AttemptTimeout`。
4. **Clock/IdGen 注入**：Web Host 用 `Date.now()` 与 UUID；Desktop Host 用 `std::time` 与 Tauri 侧生成——Bridge 构造时注入，两侧同语义。

## 5. 浏览器测试清单（Phase 1 恢复对象）

archive/ts/verify/demo-playwright.mjs：B01–B32（34 项，含 B02 三参数化、B12 组合/IME、B18 CDP 崩溃注入、B20–B29 附件节点/移动/剪贴板、B30–B32 MIME/元数据/队列取回）。注入点 `window.composerTest`（engine/failWrite/holdWrite/moveAttachment）→ 改指 Bridge 门面，用例主体不动。
