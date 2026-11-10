# OUT-002：WASM Host 桥面跑通首要链路（真实 Rust Core 18/18）+ TS 协议/Provider

- **轮次**：goal 后第二次输出
- **日期**：2026-11-11

## 本轮做了什么

1. **composer-bridge-wasm crate**（D003）：wasm-bindgen 导出 `WasmBridge`，JSON 字符串单一序列化路径（与未来 Tauri IPC 同构）；Clock/IdGen 宿主注入；持久化 = ScopeState JSON 进出（FM09 恢复已验）。
2. **首要链路真实跑通**（Node 冒烟 18/18，真实 WASM Core 非 mock）：Edit→Persist 引用→ack→Submit 交接（FM01 草稿清空）→Persist→ack→**真实引擎泵送 Deliver+ScheduleTimeout**→Deliver accepted→Persist→ack→**Outbox Accepted + 轮次激活**；外加 ack 幂等守卫（UnknownRef）、坏 JSON 显式报错、恢复 sending→unknown（FM09）。wasm-bindgen pkg 已在校机产出（release wasm32）。
3. **语义修正一处**：冒烟第一版断言 Edit 后 admitting=true 是错的——TS core.ts 的 edit 不设 admitting（仅 submit/restore），Rust 对齐正确，断言改 false（D003 §5，教训：对拍以 archive 源码为准）。
4. **TS 侧**：`app-react/src/generated/protocol.ts`（BM05 契约冻结的类型+守卫）+ `src/composer/ComposerProvider.tsx`（**原子订阅**：useSyncExternalStore + 注册即推基准快照 + revision 单调缓存过期丢弃；MemoryBridgeClient 测试替身仅测试用）。校机 tsc --noEmit ✓。
5. 校机门禁：**cargo test --workspace 100/100** + bridge-wasm native/wasm32 check ✓ + rustfmt 同步回本地。

## 验证证据

- wasm 冒烟：`composer-bridge-wasm/verify/wasm-smoke.mjs` 18/18（`.tmp/riir/evidence/wasm-bridge-build-4.log`）
- 全 workspace：100 passed / 0 failed（`bridge-wasm-gate.log`）
- TS typecheck：✓（`ts-check-2.log`）

## 推送

- 本轮提交：见 push 后 ls-remote（含 D003/OUT-002 + wasm crate + TS 协议/Provider）

## 下一步

1. UI 接线：`WasmEngine` 适配 archive ComposerEngine 接口（edit/submit/subscribe/getSnapshot），LexicalEditor/ChatComposer 收口到 Provider——Lexical onChange → dispatch(edit)、Enter → submit。
2. 浏览器端到端：demo 页加载真 pkg（wasm-bindgen web target），Playwright 跑「真实输入 → Outbox 可见」并恢复 B 系列首条链路断言。
3. Tauri 2 Desktop Host（Phase 4）。
