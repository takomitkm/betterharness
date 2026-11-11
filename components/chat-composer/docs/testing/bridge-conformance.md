# bridge-conformance.md（Bridge Conformance Tests——Phase 5 计划）

> 跨 Host 一致性测试规划（A+ 计划 §八）。本文定义测试序列、必测异常场景、对拍口径。
> 当前状态：Web WASM Host 首链已通（E2E 10/10 + Node 冒烟 18/18）；Desktop Host 未实现——本文先冻结测试规范。

## 1. 统一测试序列

```
初始化 Composer
       |
获取 Snapshot (revision=0)
       |
Edit { text: "你好 Bridge" }
       |
Persist → ack(ok=true)
       |
Submit → Persist → ack(ok=true) → Deliver → ack(accepted)
       |
Snapshot: Outbox[0].status = Accepted
       |
检查：draft.text = "" (FM01) / active_turn = turn-{id}
```

## 2. 必测异常场景

| 场景 | 断言 | 绑定 FM |
| --- | --- | --- |
| 重复 Dispatch | 幂等（同 id 不重复入 outbox） | FM01 |
| 重复 Effect 回执 | AckError::UnknownRef（幂等守卫） | BM03 |
| 错误 Effect 引用 | AckError::UnknownRef | BM03 |
| 并发 Dispatch | 串行处理（串行队列保证） | FM01 |
| 过期 Snapshot | UI 丢弃（revision 比较） | D002 |
| 订阅过程状态更新 | 原子订阅返回基准 + 推送增量 | D002 |
| 订阅断开后重连 | 重新获取完整状态 | D002 |
| UI 卸载 | Runtime 生命周期不受影响 | §5.6 dispose |
| Host 销毁 | Effect 全部取消 | FM18 |
| 处理中发生错误 | 异常→unknown，不自动重发 | FM03 |
| 多 Composer 实例 | 互不干扰（scope 隔离） | §7.3 |

## 3. 对拍口径

- 比较字段：snapshot.state（submissions/draft/active_turn）+ revision + effects 类型序列
- 排除字段：instance_id（随机）、时间戳（clock 注入不同）
- 格式：canonical JSON（key 排序 + 无空白）

## 4. 测试运行矩阵

| 宿主 | 测试文件 | 环境 |
| --- | --- | --- |
| Native Rust | cargo test -p composer-runtime | 校机 |
| WASM Node | node crates/composer-bridge-wasm/verify/wasm-smoke.mjs | 校机 Node |
| Dioxus Web | node app-web/verify/island-e2e.mjs | 校机 Playwright + msedge |
| Dioxus Desktop | 待实现（Phase 6） | 校机 + 目标 WebView |
