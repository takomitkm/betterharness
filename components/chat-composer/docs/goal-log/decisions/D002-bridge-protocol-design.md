# D002：Bridge 协议形状——composer-bridge-protocol crate

- **日期**：2026-11-11
- **状态**：已采纳并落地（6 项测试绿，wasm32 编译过）
- **关联**：PRODUCT-LINE-PLAN Phase 2；`docs/architecture/composer-asset-inventory.md` §4 语义缺口

## 决定

1. **新 crate `composer-bridge-protocol`**，不塞进 runtime：runtime 保持纯事件/效果引擎（无协议包袱），协议层负责 DTO 形状 + 引用配对 + revision。runtime 语义零改动（符合资产保护清单）。
2. **DTO 独立定义而非直通内部类型**：`ComposerEventDto`/`EffectDto`/`EffectOutcomeDto`/`SnapshotDto` 用 serde JSON 形状冻结（BM05 形状测试 = TS 生成类型的契约）。内部强类型 id（MessageId/AttemptId）在 DTO 边界转字符串——TS 侧不背 Rust newtype。
3. **revision = Bridge 级计数，每次快照发射必增**（含无变化的 dispatch）。备选「只在状态变更时增」被否：runtime 不回报"是否变化"，用 effects 非空作代理会漏 Close（只发 CancelAllLookups）。保守多增无害——UI 只忽略过期快照，不会误丢。
4. **Effect 引用配对**：除 `Cancel*`（fire-and-forget，ref_id=0）外每个 Effect 发引用；ack 从 pending 摘除后映射回 runtime 事件。重复/未知引用 → `UnknownRef`；形状不匹配 → `OutcomeMismatch`。幂等性由「摘除后才映射」保证（BM03）。
5. **UI 事件面收窄**：dispatch 只收用户可发事件；Persisted/DeliverResult/AttemptTimeout/LookupResult 只能走 ackEffect——UI 无法伪造投递结果。
6. **Edit 事件 v1 仅文本**（`Edit { text }`）：有序文档 JSON 与附件身份经 Bridge 传输的形状留待 Phase 2 后半（asset-inventory §4.1 的 Blob 映射方案），不在 v1 硬塞——避免在 Document 边界未定型时冻结错误协议。
7. **并发串行化责任归宿主**：BridgeCore 不内部加锁（wasm 单线程天然串行；Tauri command 队列串行）——文档化于结构注释，避免双重锁引入死锁面。
8. **Clock/IdGen 注入**：BridgeCore 构造参数（闭包）。Web 用 performance.now() 基准 + crypto.randomUUID；Desktop 用宿主等价物。

## 备选与取舍

| 备选 | 否决理由 |
| --- | --- |
| ts-rs 自动生成 TS 类型 | 引入构建步依赖；v1 用 BM05 形状测试冻结 JSON + 手写 TS 对照（Phase 2 后半），迁移 ts-rs 时不破坏契约 |
| Bridge 直接复用 archive/ts 的 useComposerSubmission 订阅模型 | 那是 React hook 层；Bridge 必须框架无关（Dioxus 实验线也要能接） |
| ack 结果只返回 ok 布尔 | 丢掉回执引发的后续 Effect（如 Persist→Deliver 链），宿主要多一轮 getSnapshot——返回 DispatchResultDto 一步到位 |

## 后果

- Phase 2 下一步：TS 侧 `generated/protocol.ts` 对照 BM05 形状；ComposerProvider 订阅语义（原子订阅：subscribe 返回基准快照 + revision）；app-react 的 core.ts 调用点收口。
- 已知边界：Edit v1 仅文本——富文本链路在 Bridge 落地 UI 前不冻结。
