# core-rs — Rust 参考实现

> **定位：参考实现，未接入生产。** 本目录上层的 TypeScript 实现（`../core.ts`）
> 才是生产代码：25/25 核心故障测试、21/21 真实 Edge 浏览器测试、14/14 变异校准
> 全绿，见 `../verify/RESULTS.md`。这个 crate 验证的是「同一套契约在 Rust 里
> 由编译器而非测试守住」，将来要三端（桌面/web/移动）复用同一核心时可直接接手。

## 这个移植证明了什么

TS 版里靠 25 个测试和代码纪律守住的三件事，在 Rust 里变成编译错误：

| 纪律 | TS 里的守法人 | Rust 里的守法人 |
|---|---|---|
| 草稿交接后旧引用不能再碰已发消息 | `structuredClone` + `Object.freeze` + 测试 | `std::mem::replace` 移出所有权，借用检查器 |
| `settle` 不能拿 A 的回执改 B 的状态 | 显式先读 `(status, queued_for_turn)` 再写 | 借用冲突拒绝编译，强制分阶段 |
| 状态集合必须穷尽处理 | `normalize()` 运行时兜底 + 测试 | `match` 缺分支不通过编译 |
| 消息/轮次/草稿的 ID 不能互相混用 | 参数约定（字符串都是 string） | newtype，传错类型编译不过 |

移植过程中编译器真的拦下了 6 处借用冲突（`settle` 里同时读 `self.active_turn`
和对 `self.submissions` 的可变借用）和 1 处缺 `Ord`——这是写代码时就发生的事，
不是重构后的美化叙述。

## 契约

`uncertain`（TS 里叫 `unknown`）是唯一没有自动出口的
状态：阻塞队列派发，且拒绝 `retry`/`restore`/`remove`——这条设计
和 TS 版一致，冒烟测试第 6 组断言就是验它。

## 文件

| 文件 | 内容 |
|---|---|
| `src/ids.rs` | newtype 身份、`DeliveryResult` 三态、`validate_result` 回执身份校验，含 5 个单测 |
| `src/state.rs` | `ScopeState`：草稿 + 账本 + 轮次簿记；`handoff`/`begin_next`/`settle`/`retry`/`restore`/`remove`/`begin_turn`/`end_turn`，含 13 个单测 |
| `src/wasm.rs` | wasm-bindgen 导出层（仅 `cfg(target_arch = "wasm32")` 编译） |
| `verify/wasm-smoke.mjs` | 跨 JS↔wasm 边界冒烟测试，23 个断言 |

## 复现步骤（校机；依赖见下）

```sh
cd core-rs
export CARGO_HOME=... RUSTUP_HOME=... PATH=...cargo/bin:$PATH
cargo test --lib                                              # 18 passed
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg \
  target/wasm32-unknown-unknown/release/composer_core.wasm
node verify/wasm-smoke.mjs                                    # 23/23 passed
```

## 验证（2026-11-07 校机）

| 项 | 结果 |
|---|---|
| `rustc` | 1.85.1（windows-gnu，需 MinGW gcc 在 PATH） |
| `wasm-bindgen-cli` | 0.2.100；**`cargo install --locked` 才能装**——不加 `--locked` 会拉到要求 rustc 1.88 的传递依赖 |
| crate 依赖 | wasm-bindgen `=0.2.100`（版本必须与 CLI 严格一致，否则绑定拒绝生成）、serde、serde_json、js-sys、web-sys |
| `cargo test --lib` | **18/18** |
| wasm 产物 | 272 KB（LTO + `opt-level=s` + `panic=abort`），bindgen 后 JS 16.6 KB + d.ts |
| Node 24 跨边界冒烟 | **23/23** |

`target/` 和 `pkg/` 都不入库（见 `.gitignore`）；上面步骤可从仓库文件完全重建产物。

## 移植边界（没做的部分）

- **附件字节不过边界**：Rust 只持有附件 *ID* 列表，Blob 仍由 JS 存储层管理。
  避开 wasm-bindgen 传 Blob 的坑，同时保住「payload 归属随消息走」的所有权语义。
- **IndexedDB / CAS / strict durability 不移植**：web-sys 做 IndexedDB 事务是
  另一坨胶水，且 TS 版存储层已经有 B13 多标签冲突测试覆盖。
- **没有移植的东西 = 不能宣称等价**：本 crate 等价的是状态机层（`core.ts` 的
  submit/settle/retry/restore/remove/turn 逻辑），不是整个 TS 组件。

冒烟测试过程中踩过的两个坑（都记在这里，避免重复怀疑）：
1. `beginNext` 返回 `null` 是**正确行为**——m1 被接纳进了 turn-1，普通 start 就该
   等轮次结束才推进。第一版冒烟脚本没 `endTurn` 就以为实现有 bug。
2. 冒烟脚本里对 retry 场景复用同一 scope 会撞上 m3 的 uncertain 阻塞（设计如此），
   已改成独立 scope `scope-2`。
