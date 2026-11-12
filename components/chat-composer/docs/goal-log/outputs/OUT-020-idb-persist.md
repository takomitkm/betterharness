# OUT-020：E3c 完成——Rust 主线 IDB 持久化 + 悬停高亮（IDB E2E 6/6 + 四套回归全绿）

- **轮次**：goal 后第二十次输出
- **日期**：2026-11-13

## 本轮做了什么

1. **URL scope 隔离**（`?scope=`）：RuntimeConfig/回执/IDB 键参数化——修 FM15
   回执身份（写死 scope 在隔离下全转 uncertain）。
2. **IDB 持久化**（idb.rs，web 专有）：request_put 防抖串行写循环 + Closure::once
   回调 + oneshot；executor.persist 落 IDB；协程启动恢复（FM09）+ 恢复草稿写回
   taino_editor。
3. **悬停高亮**（件 2）：Hover 事件 + onmouseenter。
4. **上游确认**：dioxus-desktop 适配器在 taino-edit 无任何排期（ROADMAP/issues
   零提及）；PR #24 open 等作者。

## 验证证据（校机）

- `idb-once.log`：**IDB E2E 6/6**（提交落库含 accepted/ reload 恢复 outbox/
  未提交草稿 reload 保留/悬停高亮/零错误）
- `e3c-final-all.log`：**四套回归 14/14 + 12/12 + 18/18 + 24/24**
- `e3c-build23.log`：wasm32 构建零错误

## 排查实录（D020 全录）

- setTimeout 轮询的 JsFuture await 在 spawn_local 下卡死（6 轮）→ Closure::once 正解
- 并发 put 事务顺序不定 → 防抖串行写循环
- 「vendor ≠ 最新 wasm」烧三轮 → 运行脚本并入 bindgen
- FM15 回执身份 / waitForFunction predicate 作用域 / rAF 轮询不可靠

## goal-log：D001–D020 + OUT-001–OUT-020

## 剩余（低优先/外部）

- React WASM 线进 CI（job 结构不同，可选）
- 本地 main 与远端对齐（校机流或 443 恢复）
- 上游 PR #24 等响应；desktop 切 taino 等上游适配器
