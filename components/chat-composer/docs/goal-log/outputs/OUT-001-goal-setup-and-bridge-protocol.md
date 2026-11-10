# OUT-001：日志建立 + Phase 0/1 收尾 + Phase 2 开工（Bridge 协议 crate）

- **轮次**：goal 设置后第一次输出
- **日期**：2026-11-11

## 本轮做了什么

1. **Goal 日志建立**（D001）：`docs/goal-log/{decisions,outputs}/` 结构 + README 索引 + 记录约定。
2. **Phase 0 完成**（已在上一轮推送，本轮正式记入日志）：三份报告——asset-inventory / baseline / wasm-compatibility（Go 门：10/10 crate wasm32 编译过）。
3. **Phase 1 第一步完成**（已推送）：`app-react/` = archive/ts 整体恢复；校机实测 npm ci + typecheck ✓ + 单元 76/76 + 浏览器 34/34（msedge）+ 变异 14/14 killed，零回归；baseline 文档更新其数字。
4. **Phase 2 开工**：新 crate `composer-bridge-protocol`（D002 决定）——DTO 冻结（BM05 形状测试）+ BridgeCore（dispatch/ack/snapshot，Effect 引用配对幂等，revision 每发必增）+ 6 项测试。
5. 校机门禁：**cargo test --workspace 100/100 绿**（+6 Bridge），bridge crate wasm32 编译 ✓，rustfmt 已过并同步回本地。

## 验证证据

- `cargo test -p composer-bridge-protocol`：6/6（BM01 修订单调 / BM02 提交全链路 / BM03 ack 幂等 / BM04 超时→unknown 阻塞 / BM05 JSON 形状冻结 / BM06 close 无引用 Cancel）
- 全 workspace：100 passed / 0 failed（校机）
- wasm32：composer-bridge-protocol ✓
- evidence：`.tmp/riir/evidence/{phase0-wasm,app-react-verify,app-react-counts,bridge-test-3,bridge-gate}.log`

## 推送

- Phase 0 报告：`e86162f`
- app-react 恢复：`6cd37ad`
- 本轮（goal 日志 + Bridge crate + D002/OUT-001）：见 push 后 ls-remote 核对

## 下一步

1. TS 侧 `app-react/src/generated/protocol.ts` 对照 BM05 形状 + ComposerProvider（原子订阅：subscribe 返回基准快照）。
2. app-react 的 engine 调用点收口到 Bridge 门面（wasm-bindgen 导出 BridgeCore）。
3. 首要交付链路：Lexical 输入 → Provider → Bridge → Rust Runtime → Submit → Outbox 可见（先 Web WASM）。
