# composer-bridge.md（Composer Bridge 协议设计）

> Phase 2 交付物。Bridge 是 Rust Core 与所有 UI 宿主（React 参考 / Dioxus 产品 / 未来 Tauri）之间的**正式协议边界**，不是简单的函数包装。
> 决策链：D002（协议形状 + 引用配对 + revision 策略）→ D005/D006（产品方向）→ 本文档。

## 1. 协议版本

`PROTOCOL_VERSION = 1`（`composer-bridge-protocol` crate 常量）。DTO 形状变化必须递增并同步 TypeScript 类型（`app-react/src/generated/protocol.ts`）。

形状冻结由 BM05 测试保证：`tests::bm05_dto_json_shapes_are_stable` 逐字段断言 serde JSON 输出。

## 2. Bridge 最小接口

```rust
impl BridgeCore {
    pub fn snapshot(&self) -> SnapshotDto;                          // 当前快照（不推进状态）
    pub fn dispatch(&mut self, event: ComposerEventDto) -> DispatchResultDto;  // UI 事件
    pub fn ack(&mut self, ref_id: u64, outcome: EffectOutcomeDto) -> Result<DispatchResultDto, AckError>;  // Effect 回执
    pub fn persist_revision(&self) -> u64;                          // Persist CAS expected
    pub fn pending_effect_count(&self) -> usize;                    // 未回执引用数（诊断）
}
```

## 3. 事件面收窄

UI 只能发 ComposerEventDto（Edit/Submit/SetBusyMode/轮次/Restore/Retry/Remove/Flush/Resume/Close）。
回执类事件（Persisted/DeliverResult/AttemptTimeout/LookupResult）只能经 `ack()` 进入——杜绝 UI 伪造投递结果。

## 4. Effect 引用配对

除 `Cancel*`（fire-and-forget，ref_id=0）外每个 Effect 带唯一 ref_id。ack 从 pending 摘除后映射回 runtime 事件。三类错误：

| 错误 | 条件 | 语义 |
| --- | --- | --- |
| UnknownRef | 引用不存在/已回执 | 不重复提交事务（幂等） |
| OutcomeMismatch | 回执类型与 Effect 不匹配 | 宿主实现 bug 显式暴露 |
| （无错误路径） | 同一 Effect 的合法回执 | 正常处理 |

## 5. revision 单调递增

每次快照发射（dispatch/ack/任何 run() 调用）+1——包括无状态变化的 ack。保守多增无害：UI 只忽略过期快照，不误丢。

BM07 测试验证 persist_revision CAS 计数序列：ok=true 递增、ok=false 保持、宿主重试用同一 expected。

## 6. JSON 单一序列化路径（D003）

Web（wasm-bindgen）与 Desktop（Tauri IPC）共用 JSON 字符串进出。**不展开 wasm-bindgen 结构体**——两条序列化路径会让跨 Host 对拍退化为不同协议的比对。

## 7. 并发串行化

单实例 Dispatch 串行处理由宿主保证（wasm 单线程天然串行 / Tauri command 队列）。BridgeCore 不内部加锁——避免双重锁引入死锁面。

## 8. 测试

| 测试 | 覆盖 |
| --- | --- |
| BM01 | revision 每发必增 + Persist 引用产出 |
| BM02 | Submit 全链路（交接→派发→接纳→Outbox） |
| BM03 | ack 幂等（UnknownRef）+ 形状不匹配（OutcomeMismatch） |
| BM04 | 超时→unknown + 阻塞队列（FM09） |
| BM05 | DTO JSON 形状冻结 |
| BM06 | close 无引用 Cancel |
| BM07 | persist_revision CAS 序列 |
