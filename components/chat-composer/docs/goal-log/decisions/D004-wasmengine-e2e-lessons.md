# D004：WasmEngine 适配层与浏览器 E2E 的关键决定/教训

- **日期**：2026-11-11
- **状态**：已采纳并落地（浏览器 E2E 10/10，76 单元零回归）
- **关联**：D002/D003；PRODUCT-LINE-PLAN Phase 1 第二步 + Phase 3 验收

## 决定

1. **WasmEngine 按形状适配而非类型继承**：core.ts 新增 `EngineFace`（Pick 最小面），`useComposerSubmission`/`ChatComposer` 参数放宽为 EngineFace——WasmEngine 结构兼容即可注入，组件调用点零改动（TS 结构类型的正确用法）。
2. **Effects 泵**：Bridge 的 ack 会产生后续 Effect 链（Persist→Deliver→Persist→…），WasmEngine 用**接力泵循环**（guard 64）一次跑完整链，对齐 TS engine 的 commit→pump 语义；ScheduleTimeout 例外——注册真实 setTimeout、到期独立 ack，结果先到则 cancel。
3. **WasmBridge 构造签名必须带 scope**：回执 `receipt.scope` 必须与 RuntimeConfig.scope 一致，否则 IdentityMismatch→uncertain（FM15 兜底正确工作，但根因是宿主配错身份）。教训：**Bridge 构造参数即身份契约**，scope 从 URL/配置一路穿透。
4. **DTO `uncertain` → TS 契约 `unknown`**：同一语义两侧历史命名不同，映射集中在 WasmEngine applySnapshot（不在协议层改名——JSON 形状已冻结）。
5. **Transport 错误隔离**：deliver 的 transport.send 异常在 executeEffect 转 uncertain（FM03），绝不裸抛进泵。

## 教训（E2E 调试实录，每条都烧过一轮）

1. **等待谓词的形状错误**：浏览器 E2E 的 wait 用 `submission.text`，而原始 View 的 submissions 是 `{snapshot: {text}}` 嵌套形状——谓词永远 undefined → 30s 超时。**根因修复 = 全部改 `submission.snapshot.text`**。引擎本身零 bug（rev 13 状态早已 Accepted）。
2. **测试隔离**：scope 固定值 + IndexedDB 跨 run 持久 = 上一轮的 queued C 与活跃轮次被恢复，本轮全部错位。修复 = scope 加时间戳唯一化。
3. **日志截断骗人**：run 脚本的 `tail -18` 让我以为 rev 1–12 不存在；去掉 tail 才看到完整事件链。
4. **悬空标识符静默吞掉**：`console.log(..., bridge.pending_count())` 在无 `bridge` 参数的方法里 → ReferenceError 被 enqueue 的 catch 静默吞 → 泵链断在半空。修复后 E2E 即通。
5. **hold 场景前置**：hold 需要 delivery 真实派出才有人被挂起——turn 活跃时（queue 模式）提交只会入队。测试先 end-turn 再 hold-submit。

## 后果

- 首要交付链路（Lexical 输入 → Provider/Bridge → Rust Runtime → Outbox 可见）已在真实浏览器 + 真实 WASM Core 上端到端验证（E2E 含 FM01/02/09/11/12 的浏览器版活体验证）。
- 已知边界：富文本 document/附件 Blob 车道（协议 v2）、IndexedDB 真持久化、主动 lookup、Tauri Desktop Host。
