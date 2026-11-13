# D021：E3d——不可靠网络 E2E（场景化 executor）+ 菜单点击选择 + host 构建纪律

- **日期**：2026-11-13
- **状态**：已落地（network E2E 12/12 ×3 稳定 + 六套回归 92 判据全绿）
- **关联**：D011（executor 内存面→场景化）；D018（菜单）；OUT-021

## 决定

1. **场景化回环 executor**（URL `?scenario=`）：accept（默认）/reject/uncertain（丢 ack）——
   不可靠网络的 E2E 驱动面。超时**真触发**（ScheduleTimeout 到点 spawn js_sleep 回
   AttemptTimeout）。运行时切场景走 `AppEvent::SetScenario`（宿主可切传输行为）。
2. **composerTest 注入钩子**（web 专有）：`__composerTest({kind: "lookup"|"timeout"|"scenario", ...})`
   ——E2E 注入 LookupResult/AttemptTimeout/场景切换。**注册必须在 use_coroutine 之后**
   （协程内注册因槽位时序静默失效——hook 块曾丢失+时序双重坑，E3d 实录）。
3. **URL scope 隔离普及**：menu/attach 的 freshPage 改唯一 scope（IDB 持久化后
   freshPage 会恢复上一段状态——clearDatabase 与页面连接竞争不可靠，唯一 scope
   = 天然全新基线）；attach 的 upload 后等 rail 卡片渲染再 focus（附件异步到达的
   重渲染抢焦点——focused=DIV 实录）。
4. **判据语义三修**（产品语义澄清）：
   - uncertain **无轮次开立**（未确认不入轮——active_turn 保持 null）；
   - lookup 恢复 accepted 后 **queued 保持排队**（turn 闸门 FM12——不自动派发，
     等 end_turn）；5d 验证 end_turn 派发 ✓；
   - 菜单**点击接受只替换写回不提交**（提交需 Enter——与键盘 Enter 接受同语义，
     enter-accept 也不提交）。
5. **跨机构建铁律确立**：解包 → `find -name "*.rs" -exec touch` → cargo build →
   bindgen → run **同一脚本**——跨机时钟差 + tar 保留 mtime 让 cargo 误判 fresh
   （"改了没生效"三轮的元凶，D010 同款实录的根治）。

## 后果

- 六套 E2E（基线 18 + 菜单 14 + 附件 12 + IDB 6 + island 24 + network 12 = **92 判据**）
  全绿且 network 三连跑稳定。
- 不可靠网络语义（FM04/05/25 + turn 闸门）在 Rust 主线 E2E 面闭环。
- composer-host 的「场景化 executor」为真实传输接入提供了模板（scenario 即传输行为注入点）。
