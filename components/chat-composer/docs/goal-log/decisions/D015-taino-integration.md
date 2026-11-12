# D015：E1 换装完成——app-web 集成 taino-edit，taino E2E 18/18 + island 回归 24/24

- **日期**：2026-11-13
- **状态**：已落地（taino E2E 18/18 + island E2E 24/24 回归，双模式并存）
- **关联**：D014（Go）；D013（对拍清单）；OUT-014

## 决定

1. **三编辑器模式并存**（`?editor=` 参数）：`taino`（E1 新门，Pure Rust Editor）/
   `lexical`（island fallback，24/24 回归保持）/ textarea（默认）。taino 分支
   Dioxus 组件直挂——无 island.js 容器装载、无 CustomEvent 桥，Enter 走 Rust 内部。
2. **Enter 仲裁接线**：taino Keymap 的 "Enter" binding 内跑 composer-keynav
   decide_enter（ImeTracker = keynav.ts 同款 Rust 最小版，根级 composition 监听喂入，
   KD10/KD03）→ Submit 进协程 → ComposerHost。**Box<dyn Fn> 里不能拿 &mut**——
   状态变更全在协程（composer-host 同构）。
3. **草稿同步**：use_effect 监听 taino state → `doc_plain_text`（多段落按 \n join——
   Node::text_content 不加块分隔，E1 实录）→ Event::Edit。taino state 是编辑态唯一事实。
4. **FM01 事务式清空**：`state.tr().transform().replace(0, size, Slice[空段落])` +
   `apply(tx)`——**不用重建 EditorState**：重建会让选区失联，后续打字字符反转
   （"selection test" → "tset noitceles"，E1 实录）；事务式保历史与选区映射。
   undo 栈保留（清空本身可撤销——比 D014 预估的「重置」更优）。
5. **依赖统一 wasm-bindgen 0.2.130**（app-web pin 0.2.100 → 0.2.130，校机 CLI 已装）；
   taino 依赖放通用区（wasm-bindgen 栈在原生目标编译为桩，desktop 分支不渲染但可编译）。
6. **双实例检查移除**（island 8a-c）：单编辑器应用；taino 的实例隔离 = 每组件独立
   EditorState（框架保证），不进 E2E 门。

## 实录

- taino Keymap 块的闭合符顺序（`)],` vs `]),`）烧了四轮——逐行栈快照词法器
  （delim_trace.py）定位：L416 后栈顶 = vec![387，L418 的 `)` 先于 `]` 到达 = 错配。
- `#[cfg]` 不能挂 rsx 节点 → taino 依赖移通用区（原生编译为桩）替代门控体操。
- wasm32 无 SystemTime 的 Clock 纪律再次实录（spike 同款 js_sys::Date::now）。

## 后果

- Pure Rust Editor 落地：web 端 `?editor=taino` 即产品形态（无 JS 编辑器依赖）
- D013 对拍清单的 taino 腿就位；island 保持 fallback 直到 taino 稳定运行一个周期
- undo 跨清空语义反超 island（可撤销清空 vs Lexical 的 setDocument 不穿越恢复点）

## 下一步（E2 候选）

- desktop 面板切 taino 面（wasm 在 WebView 里同样跑——需 desktop 加载资产管线）
- 性能基线（D013 的「性能合格」项）
- 上游反馈：FM01 选区失联问题作为 taino-edit 的 issue 素材（判据/复现齐备）
