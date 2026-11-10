# wasm-compatibility（Phase 0 Go/No-Go 门）

> 结论：**Go**。产品线核心全部 crate 通过 wasm32 编译，无需为 WASM 复制任何业务逻辑。
> 检查时点：2026-11-11，校机 rustc 1.99.1 / wasm32-unknown-unknown 已安装。

## 1. 逐 crate 结果（cargo check --target wasm32-unknown-unknown）

| crate | 结果 | 外部依赖 | 备注 |
| --- | --- | --- | --- |
| composer-core | ✓ Finished | serde | 纯数据 + BTreeSet/Vec，无 IO |
| composer-keynav | ✓ | 无 | 纯函数 + 注入时钟 |
| composer-completion | ✓ | 无 | 纯状态机 |
| composer-intake | ✓ | 无 | 纯函数 |
| composer-reorder | ✓ | 无 | 纯函数 |
| composer-snapshot | ✓ | serde_json | JSON 值校验（serde_json wasm 支持 ✓） |
| composer-plugin-api | ✓ | serde_json | Mutex/TypeId/Arc<dyn Any> 均为 std，wasm32 单线程可用；EventBus 用 Mutex 非 tokio |
| composer-composition | ✓ | toml | toml 纯解析（wasm ✓） |
| composer-runtime | ✓ | composer-core | Clock/IdGen 是 trait——平台注入，无直接时间/随机调用；无 async runtime 依赖 |
| attachment-tools | ✓ | composer-plugin-api, composer-reorder, serde_json | 闭包 fetch 是同步 trait |

## 2. 风险点核查（PRODUCT-LINE-PLAN §3.3 清单逐项）

- **文件系统/OS API**：无（全 crate 不触 std::fs / std::process）。
- **线程与同步**：plugin-api 用 `std::sync::Mutex`——wasm32 单线程下可用（无阻塞风险：所有临界区不等待外部异步）。
- **异步 runtime**：无 tokio/async-std 依赖；runtime 的异步性全部由宿主以 Effect 回执形式注入，Core 内是同步 step。
- **动态加载**：无（WASM 插件宿主是后续阶段，届时经 Wasmtime 引入，不在本门范围）。
- **时间/随机数**：Core 不取系统时间（Clock trait 注入）、不生成随机数（IdGen 注入）——设计即隔离，无需修补。
- **第三方 crate**：serde/serde_json/toml/dioxus（app-web）全部有 wasm32 支持记录且实际编译通过。

## 3. 遗留观察项（不阻塞，Phase 2/3 注意）

1. **`Arc<dyn Any + Send + Sync>` downcast**：plugin-api 服务容器在 wasm32 编译通过；运行期行为（TypeId 跨 `dyn Any` 匹配）在单线程 wasm 与原生一致，无平台分支。
2. **Clock 粒度**：Web Host 用 `Date.now()`（毫秒，可回拨——FM23/24 依赖单调性的测试用的是注入固定时钟，宿主实现建议 `performance.now()` 基准防止系统回拨）。
3. **IdGen**：Web 用 `crypto.randomUUID()`（浏览器原生），Desktop 用 Tauri 侧生成——Bridge 构造参数，无 Core 改动。
4. **app-web 编译验证 ≠ 产品线构建**：app-web 验证的是 core+keynav 路径；本次已补齐 runtime/plugin-api/composition 等全部 crate 的独立验证。
5. **体积**：未测 release wasm 体积；Bridge 落地后若 >2MB 再评估 `wee_alloc`/`opt-level=z`（不做预防性优化）。

## 4. 门禁记录

```
composer-core:        Finished dev profile (wasm32)
composer-keynav:      Finished
composer-completion:  Finished
composer-intake:      Finished
composer-reorder:     Finished
composer-snapshot:    Finished
composer-plugin-api:  Finished
composer-composition: Finished
composer-runtime:     Finished
attachment-tools:     Finished
workspace baseline: passed 94 / failed 0
```
