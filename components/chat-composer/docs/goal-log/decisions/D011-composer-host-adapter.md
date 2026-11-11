# D011：composer-host 适配器——Dioxus 直调 Runtime 的事件循环架构

- **日期**：2026-11-12
- **状态**：已落地（原生测试 10/10 + island E2E 24/24 回归 + workspace 111/0，零警告）
- **关联**：D006/D009；PRODUCT-LINE-PLAN §7.1–7.5（Phase 4）；OUT-010

## 决定

1. **新 crate `composer-host`**：UI 无关的 Rust 直调适配层。
   `ComposerHost::dispatch(Event) -> &ScopeState`：Runtime.step 出 [`Effect`] →
   [`EffectExecutor`] 执行 → 结果以 [`Event`] 回灌 → **排空至不动点**（DRAIN_GUARD=64，
   对齐 WasmEngine pump）。强类型传递，零 JSON——协议测试（BM 系列）仍守 wasm/JS 桥路径，
   不因直调而绕开（§7.2 纪律）。

2. **Executor 同步形状 + 明确边界**：persist/deliver/schedule_timeout/cancel_timeout 为
   同步 trait。演示回环 Deliver 立即接纳（回执 scope 必须与 RuntimeConfig.scope 一致——
   配错身份 FM15 正确兜底转 uncertain，D004 实录）；persist 为内存面（真 IDB 在 Phase 5
   React 线已实证）。真实 HTTP 传输接入时由平台层串行任务队列包裹，Runtime 的
   inflight/超时/幂等不感知执行延迟。

3. **Dioxus 侧：Host 住 use_coroutine**（单消费者天然串行，§7.5「组件重建不新建业务
   Runtime」的落实）。UI 通过 `coroutine.send(Event::...)` 进事件（textarea/island/
   按钮/取回/重试全走此路），读镜像 signal（ledger + admitting）。删除了全部
   do_submit/do_end_turn/do_recall/do_retry 直调函数与 admit_locally——不再有第二套
   业务补偿逻辑（§7.4）。

4. **island 清空依据改为 `last_dispatch_handed_off()`**：协程在 dispatch(Submit) 后
   对比 submissions 数量，增长 = 交接成功 → global_eval 清 island。与 Phase 3 语义等价，
   但判断来源是 Runtime 状态而非调用返回值。

5. **Runtime API 对齐事实**：无 `Runtime::new`，用 `restore_from_persisted(config, state)`
   兼作全新构造；`ScopeState.revision` 顶层字段从不递增（CAS 计数在 BridgeCore 层的
   persist_revision）——适配器测试的"终态落盘一致"断言直接比较整本 ScopeState。

## 排查实录

- 排空循环 `for effect in effects` 把 `effects` move 掉后循环条件还在读——
  `std::mem::take` 出批处理；
- 测试初版断言 `state.revision` 单调——前提错误（该字段恒 0），改为终态落盘一致；
- `grep ^test` 滤掉了 cargo 编译错误行导致"空输出"假象——校机脚本一律全量 tee 再过滤。

## 后果

- 行为等价回归：island E2E 24/24 在 runtime 驱动的新架构下原样通过（Phase 3 的
  全部语义面不变）。
- Phase 6 Desktop 可复用 composer-host：换 EffectExecutor（native 传输）+ Clock/IdGen，
  UI 事件循环同构。
- 协议三线并存且各有守卫：composer-host 原生测试（10）+ island E2E（24）+ BM 系列
  （bridge-protocol 7）。
