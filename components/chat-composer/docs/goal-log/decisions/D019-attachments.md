# D019：E3b 附件/图文调位——intake + reorder 引擎接线 taino 线

- **日期**：2026-11-13
- **状态**：已落地（附件 E2E 12/12 + 三线回归全绿）
- **关联**：D018（候选菜单）；composer-intake / composer-reorder 引擎；OUT-018

## 决定

1. **引擎面已备、只缺接线**：intake（策略守卫/逐项拒绝/整批拒绝）、reorder
   （AttachmentSequenceEntry 纯数学重排）、core 的 Snapshot.attachment_ids
   （has_content 附件面）全部是早前 RIIR 的产物——E3b 把它们接进 taino 线。
2. **字节 host-owned 纪律**：FileData 异步读字节只为得到 meta.bytes（大小）；
   字节本身从不进台账/快照（TS 线同款——Snapshot 只带 ids，载荷带 ids）。
   MIME 由扩展名白名单推断（demo 面）。
3. **Edit 保留现 ids（本轮核心语义）**：文本 Edit 的快照 attachment_ids 视为空
   （编辑器只拥有文本）——协程统一把 Edit 的 ids 替换为台账现值。否则打字的
   文本同步会把附件面覆盖成空（E2E 4b 实录）。附件增删/重排走独立 AppEvent
   （Attach/Detach/MoveAsset），自带完整快照。
4. **rail UI**：卡片（名称/大小/移除/←/→）+ 拒绝提示 + file input。呈现增强
   （缩略图/灯箱/翻页/object-URL 纪律）属 TS 线完整面，bounded 排除。
5. **rsx 纪律实录**：for 体禁 `let`/元组索引字面量（`asset.0`）；闭包按字段
   disjoint-capture move——多闭包共享同一 String 必须 per-button 预克隆
   （RailCard 的 id_remove/id_back/id_forward）；裸 `{}` 块里的 `if` 是 Rust 语义。

## 后果

- 五交互 Rust 线全部落地：可靠提交/IME/候选菜单/取回重试/**附件调位**。
- 附件-only 可提交（has_content 附件面）E2E 实证；intake 拒绝路径（超限单文件）
  实证。
- E3b 的字节传输（真实上传管线）仍属宿主侧——组件只管 meta 面（诚实边界）。
