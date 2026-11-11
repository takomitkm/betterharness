# OUT-003：UI 接线完成——首要交付链路在真实浏览器跑通（10/10）

- **轮次**：goal 后第三次输出
- **日期**：2026-11-11

## 本轮做了什么

1. **删误入库文件**：`components/chat-composer/fmt-check.sh`（上轮遗留）。
2. **WasmEngine 适配层**（`app-react/src/composer/WasmEngine.ts`）：实现 archive ComposerEngine 的全部公开成员（EngineFace 形状兼容，组件调用点零改动）；内部 = WasmBridge dispatch/ack + **Effects 接力泵**（guard 64，ScheduleTimeout 注册真实 setTimeout）；transport 错误转 uncertain（FM03）；DTO uncertain→TS unknown 映射。
3. **EngineFace 最小面**：core.ts 导出 Pick 类型，useComposerSubmission/ChatComposer 参数放宽——TS 结构类型让 WasmEngine 零侵入注入。
4. **demo wasm 分支**：`?wasm=1` 走 createWasmEngine；demo-server 路由 `/wasm/*`（MIME application/wasm）；build-demo 复制 vendor（不存在则跳过——诚实缺席）；composerTest.engine 注入 WasmEngine。
5. **浏览器 E2E**（`verify/demo2-wasm.mjs`，Playwright + msedge + 真实 WASM pkg）**10/10**：
   - 端到端：真实输入 → Outbox Accepted + 回环 fixture 收到（首要交付链路 ✓）
   - FM01 交接后草稿清空；hold 场景 A 在途 sending + release 后 Accepted + 迟到接纳不擦 B 草稿（FM02）；忙时 C 排队（FM11）+ end-turn 派发（FM12）；无未捕获页面错误
6. **Rust 门禁**：全 workspace 100/100（+6 Bridge）保持；bridge-wasm wasm32 ✓；rustfmt 同步。

## 验证证据

- `final-e2e.log`：E2E 10/10 + typecheck ✓ + 单元 76/76 零回归
- `demo2-wasm-24.log`：10/10 首跑
- 调试过程实录：demo2-wasm-1 → -24（悬空标识符/日志截断/scope 身份/等待谓词形状——全部进 D004）

## 推送

- 本轮提交：含 WasmEngine/EngineFace/E2E/D004/OUT-003/fmt-check.sh 删除

## 下一步

1. Phase 2 收尾：IndexedDB 真持久化接入 Persist Effect（替换内存 CAS 模拟）。
2. Tauri 2 Desktop Host（Phase 4，Native Rust Core 直调同一协议）。
3. B 系列全量测试逐项适配（当前 E2E 覆盖核心链路，B01–B32 全量恢复是 Phase 5 回归项）。
