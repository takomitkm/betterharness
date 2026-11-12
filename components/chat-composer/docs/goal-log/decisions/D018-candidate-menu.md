# D018：E3a 候选菜单——composer-completion 接入 taino 线（AppEvent 分层）

- **日期**：2026-11-13
- **状态**：已落地（菜单 E2E 14/14 + taino 18/18 + island 24/24 校机全绿）
- **关联**：D015（taino 集成）；composer-completion 引擎（早前 RIIR 产物）；OUT-017

## 决定

1. **AppEvent 分层**：`AppEvent = Runtime(Event) | Menu(MenuAction)`——菜单开着时
   Up/Down/Enter/Esc 路由归菜单（KD has_menu 契约的运行时面），Runtime 事件照常。
   协程单消费者串行处理两层；候选会话（CompletionSession）住协程内。
2. **菜单键进 taino Keymap**：ArrowUp/ArrowDown/Escape 绑定在菜单开时发
   Menu 事件并吞键（返回 true），菜单关时返回 false 让编辑器处理；Enter 绑定
   先查 menu_open——开着 = Accept（不提交），关着 = 走 decide_enter 仲裁。
   menu_open 是 `Rc<Cell<bool>>` 由 sync_menu_view 在协程内维护。
3. **触发检测**：use_effect 监听 taino state → doc_plain_text →
   `detect_trigger(text, dom_caret_char_offset())`（DOM 选区→char 偏移的树遍历）→
   session.track → pending 时 demo_provider 过滤（TS demo 同款候选表）→
   apply_candidates。**编辑态唯一事实仍是 taino state；session 是纯派生**。
4. **Accept 写回**：`apply_pick_to_text` 全文替换 → 事务重建内容（text_slice 按
   \n 分段）→ FM01 同款保选区映射；菜单随后 dismiss。
5. **内建键补齐**（taino keymap 的结构键纪律实证）：taino adapter 对
   Enter/Backspace/Delete **无论 keymap 是否命中一律 preventDefault**（structural
   键）——裸 keymap 必须自带 Backspace→delete_backward、Delete→delete_forward、
   Shift-Enter→split_block，否则删除/换行全瘫。
6. **Up/Down 必须显式 sync_menu_view**：move_highlight 只动会话，UI 面靠
   signal 刷新——漏 sync 的症状是高亮冻结在首位（4a 假失败实录）。

## 排查实录

- E2E 隔离模式升级：per-section freshPage（perf-e2e 同款）替代逐字 Backspace 清空
  ——pick 事务后选区失联（上游 PR #24 同域）使删除类清空不可靠。
- 「8de94ba 被 30s 回退」谜团定案：API ref PATCH 在此仓库不可靠（假成功+副本旧
  值），非外部 actor；443 断连期推送走校机 git 直推（真实 `main -> main` 输出为凭）。
- 四轮括号/借用迭代后构建通过：正则包装 events.send 漏右括号（三类模式手修）、
  `use_coroutine` 闭包是 FnMut——非 Copy 捕获必须体内 clone 再进 async move、
  多闭包共享 tx/Rc 须各自 clone。

## 后果

- 五交互的「候选菜单」在 Pure Rust 线落地（E3a）；附件/图文调位（E3b）待后续。
- composer-completion 引擎的 Rust 测试（16 处）+ 菜单 E2E 14/14 双层守卫。
- 断连期推送通道已验证：校机 git 直推。
