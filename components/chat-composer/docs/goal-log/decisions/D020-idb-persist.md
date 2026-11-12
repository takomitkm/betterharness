# D020：E3c——Rust 主线 IDB 持久化（FM09 落地 taino 线）+ 菜单悬停高亮

- **日期**：2026-11-13
- **状态**：已落地（IDB E2E 6/6 + 四套回归全绿）
- **关联**：D011（executor 内存面→本决定补齐）；D018（菜单）；§8.3/Phase 5 验收；OUT-020

## 决定

1. **URL scope 隔离**（`?scope=`）：RuntimeConfig/回执/IDB 键全部参数化——多会话与
   每-run E2E 隔离的正解（TS demo2-wasm 同款）。**回执 scope 必须与配置一致（FM15）**：
   写死 demo/main 在 scope 隔离下配错身份 → 全部转 uncertain（E3c 实录，Attach E2E
   一度全挂）。
2. **防抖串行写循环**（request_put）：每键 Edit 都触发 Persist——并发 put 的 IDB
   事务提交顺序不定（记录停在按键中间态，E3c 实录）→ PENDING 槽（最新覆盖）+
   常驻写循环串行落库，最终态=最新快照。
3. **IDB 回调 = `Closure::once` + oneshot**：`Closure<dyn FnMut>` 下 `tx.send(...)`
   （消耗 Sender）无法编译为 FnMut；**`setTimeout` 轮询 + JsFuture await 在
   spawn_local 下卡死**（回调未触发实录，烧 6 轮）——Closure::once 是 FnOnce
   回调的正解（内部 Option-take 自动转 FnMut）。
4. **FM09 恢复配套**：协程启动 await `idb::get(scope)` → 有记录则
   restore_from_persisted；**恢复的草稿文本必须写回 taino_editor**（否则挂载后的
   空文本 Edit 把恢复草稿覆盖掉——判据 3 实录）。
5. **悬停高亮**（件 2）：MenuAction::Hover(index) + li onmouseenter——TS
   CandidateMenu onHighlight 契约补齐。
6. **E2E 隔离改唯一 scope**（menu/attach 的 freshPage）——clearDatabase 与页面
   连接竞争不可靠，唯一 scope = 天然全新基线。

## 排查实录

- 「vendor ≠ 最新 wasm」烧了三轮：build 脚本与运行脚本分离导致 bindgen 缺席——
  全部运行脚本已并入 bindgen 步。
- E2E waitForFunction 的 predicate 在页面上下文执行：Node 侧变量必须走 arg 传参
  + predicate 显式声明参数（scope ReferenceError 实录）。
- rAF 默认轮询在静态页面不可靠——显式 polling: 100ms。

## 后果

- Rust 主线（taino）持久化闭环：§8.3 的刷新恢复/关闭后恢复语义在产品线上实证。
- IDB E2E 6/6：提交落库/reload 恢复 outbox/未提交草稿保留/悬停高亮/零错误。
- 桌面化仍等上游（D016 边界不变）；CAS 多标签页冲突→暂停链属宿主管线后续。
