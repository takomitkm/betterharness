# composer-baseline（Phase 0 基线冻结）

> 冻结时点：2026-11-11，`main=4fc2b58` 工作树（校机 D:/yzd/composer-rust-3，rustc 1.99.1 / wasm-bindgen-cli 0.2.100 / Node 24.9）。
> 本基线是后续所有阶段的回归参照：任何阶段不得让下表数字变差；失败的测试不得悄悄从 CI 删除。

## 1. Rust workspace（cargo test --workspace --no-fail-fast）

| crate | 项数 | 状态 |
| --- | --- | --- |
| composer-core | 18 | 全绿（含 FM01–FM25 台账对拍） |
| composer-keynav | 11 | 全绿（KD01–KD11） |
| composer-completion | 14 | 全绿（CT01–CT14） |
| composer-intake | 8 | 全绿（IT01–IT08） |
| composer-reorder | 10 | 全绿（RO01–RO10） |
| composer-snapshot | 7 | 全绿（FM19/FD01–FD07） |
| composer-plugin-api | 7 | 全绿（容器/响应式激活/级联回滚/失败回滚/事件可逆/内建服务） |
| composer-composition | 3 | 全绿（Profile 解析/replace/装载组合） |
| composer-runtime | 11 | 全绿（FM01/02/03/04/05-09/11/12/13/14/18/23-24 事件效果对拍） |
| attachment-tools | 5 | 全绿 |
| **合计** | **94** | **通过 94 / 失败 0 / 跳过 0** |

Release 构建：`cargo build --release --workspace` ✓（~10s）。

## 2. WASM 构建结果（详细数据见 wasm-compatibility.md）

10/10 crate `cargo check --target wasm32-unknown-unknown` 通过（Go 门成立）。
app-web（dioxus web）：`cargo check --target wasm32-unknown-unknown` ✓（此前已验证，本基线未重复跑全量构建）。

## 3. archive/ts 测试环境（Phase 1 恢复对象，本基线未执行）

- 浏览器测试：`node --test verify/demo-playwright.mjs`（34 项 B01–B32），需要 Playwright + Edge（校机配方 `CE_BROWSER_CHANNEL=msedge`）；npm ci 依赖 package-lock.json。
- 历史成绩（封存时）：76 单元 + 34 浏览器 + 14/14 变异全绿（main=6d7e456 时点）。
- 说明：archive 按计划不改；这些命令在 Phase 1 复活到 app-react 后重新计入基线。

## 4. 变异测试（archive/ts，历史）

`verify/mutations.mjs`：14/14 行为变异被杀死（FM 系列），原始源码不变。Rust 侧对应的变异纪律由 FM 对拍测试承载（同一批失败模式在 ledger/runtime 两层都有原生测试）。

## 5. 环境备注（校机）

- cargo/rustfmt/rustc 1.99.1；wasm32-unknown-unknown target 已装。
- 泄漏进程注意：跑浏览器测试前后 `taskkill //F //IM msedge.exe` 清残留（历史坑：25 个泄漏 msedge 拖慢测试到超时）。
- 传输配方：tar 单文件（scp -r 目录递归会嵌套套层——历史坑，见 archive 记录）。
