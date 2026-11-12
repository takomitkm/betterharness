# D017：上游修复尝试——taino-edit 选区失联根因实锤 + PR #24（附 B/C 候选分支）

- **日期**：2026-11-13
- **状态**：已落地（fork 三分支已推，PR #24 open；等作者响应）
- **关联**：D014/D015/D016；docs/upstream/taino-edit-selection-desync.md

## 决定

1. **根因单变量实锤**：app-web 的 FM01 临时切回「重建 EditorState」路径——
   caret(0) 默认选区 → 16/18（5b/7a 打字反转）；加 core 一行修复
   （`initial_text_caret`：默认光标进首个文本块内容位，`cur + 1` 过块开token）
   → **同路径 18/18**。A 案是根因，实验闭环。
2. **上游贡献走 fork + 三分支**（一次 PR 主修 + 两个候选分支供挑选）：
   - `fix/initial-selection-textblock`（A，主修，cb1e186）：core 一行 + helper
   - `fix/dom-selection-reanchor`（B）：`EditorView::update` 末尾重锚
     （覆盖 root-level caret；边界点映射需 position-map 语义讨论——分支说明已注）
   - `fix/adapter-selection-snap`（C）：adapter signal swap 后边界 caret snap
     （position 1 假设首子为文本块——分支说明已注）
   - fork：takomitkm/taino-edit（API 创建）
3. **PR #24**：完整分析（根因链/复现/变通/两套判据数字）+ 引用 #19（同域不同症）。
   app-web 保持事务式清空（与上游修复独立工作——上游落地后可选简化）。
4. **app-web 回滚实验态**：恢复 D015 的事务式清空 + 移除 `[patch.crates-io]`
   （指校机本地路径，不能入库）。

## 实录

- 校机无 `py` 启动器 → 远端补丁改「本地 patch + copy 文件回」
- `[patch.crates-io]` 没上校机（verify 脚本不解包 src.tgz）导致三轮假验证
  （18/18 是 E1 事务清空版，与 fixA 无关）——lock 的 source 行（registry vs
  path）才是 patch 生效的判据
- Box<dyn Fn>/Rc/Signal Copy 的借用规则、`spec()` 走 `node_type().spec()`——
  fixA 两轮编译迭代

## 后果

- 上游 PR #24 挂出：等作者 review；B/C 分支在 fork 上随时可切
- betterharness 不受影响：事务式清空独立工作；上游发版后可选简化 FM01
- desktop 化维持上游依赖结论（D016）
