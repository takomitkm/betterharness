# D006：三版计划裁决——采纳 Plan A+ 为产品方向（门控渐进），计划乙转已交付基准线

- **日期**：2026-11-12
- **状态**：已采纳（用户提出 A+ 提案，本文件为细则对比后的裁决与门控执行计划）
- **关联**：D005（乙/甲对比）；PRODUCT-LINE-PLAN.md（计划乙全文）；计划书 §3/§7/§9

## 三版对比（细则）

| 版本 | Rust 主导程度 | 编辑器风险 | 执行状态 | 定位 |
| --- | --- | --- | --- | --- |
| 计划乙：React + Lexical 双 Host | 核心 Rust | **已验证**（B 系列实测 + E2E 10/10） | **已交付基准线**（首链真实 WASM Core 跑通） | 产品线（现状绿） |
| 计划甲：Dioxus + 自研编辑器 | 最高 | 很高（编辑器不存在） | 未执行 | 纯 Rust 实验 |
| **计划 A+：Dioxus 主 UI + Vanilla Lexical 内核** | 高（React 退出运行时） | **可控**（复用乙已验证的编辑器内核） | 新提出 | **建议产品方向** |

## A+ 相对甲的关键改进（已在我方代码上核实）

**Lexical 本身不依赖 React——我方 762 行 LexicalEditor.tsx 的审计结论：**

- `@lexical/react` 耦合面 = **7 个包装导入**（LexicalComposer / useLexicalComposerContext / ContentEditable / PlainTextPlugin / HistoryPlugin / OnChangePlugin / ErrorBoundary）。
- 我方 13 处自定义注册（Enter 仲裁 / IME 跟踪 / PASTE_COMMAND / 方向键 / composer-sync 握手 / lastSelection 捕获）**全部是 vanilla 编辑器 API**（registerCommand / registerRootListener / registerUpdateListener / editorState.read / setEditorState）——零 React 耦合。
- 自定义节点（MentionNode / AttachmentNode）`decorate() 返回 null`、芯片 DOM 在 createDOM 构建——**无 React 门户**，天然框架无关。
- 迁移面 = 官方 vanilla 包直换：`@lexical/plain-text`（registerPlainText，承接 beforeinput/keydown/组合事件接线）+ `@lexical/history`（registerHistory）+ `createEditor` + `setRootElement` + `registerUpdateListener`。**是适配，不是重写编辑器**。

结论：A+ 修掉了甲的致命弱点（自研编辑器），同时保住甲的核心诉求（React 退出产品运行时、UI 全 Rust）。

## A+ 相对乙的真实收益与成本

**收益**：
1. UI 与 Core 在同一 WASM 模块（Web）：Dioxus → Core 走 Rust 直调，**消除每次按键的 JSON 桥往返**（当前 Bridge 每击键一次 dispatch→JSON→step→JSON→parse）。
2. React 退出运行时；插件 UI 贡献（ViewContribution 描述符，本就框架中立）由 Dioxus PluginSlot 直接渲染。
3. 单语言 UI（rsx），类型统一贯穿到 Core。

**成本（诚实）**：
1. archive/ts 中 React 版 CandidateMenu / AttachmentCards / ChatComposer 壳需以 Dioxus rsx 重写（PluginSlot 消费同一 ViewContribution 描述符——协议已框架中立，重写的是渲染不是逻辑）。
2. Lexical React 包装迁移（见上，官方 vanilla 包直换 + 自写 root mount）。
3. **E2E 10/10 不自动继承**——A3 集成后需重新执行端到端验收（计划原文已诚实标注）。

## 裁决与门控执行

**产品方向改为 Plan A+，但乙不回滚——它降级为「已交付基准线 + 对照组」**，A+ 未过门之前产品线仍是乙。

六阶段（采纳计划原文，补充我方门位）：

| 阶段 | 工作 | 门 |
| --- | --- | --- |
| A0 | 冻结乙交付成果：所有成功测试可重复运行 | 已达成（101 Rust + 76/34/14 app-react 基线在册） |
| A1 | Dioxus 产品 UI（不依赖 React） | 主要界面 rsx 化，读同一 Bridge 面 |
| **A2** | **Lexical Vanilla 化** | **风险总门**：PlainTextPlugin→registerPlainText 等七项换装后，B12（中文 IME）+ 选区/撤销/剪贴板用例复现 |
| A3 | Dioxus + Lexical 岛集成 | DOM 所有权纪律（Dioxus 不重建编辑器子树、Lexical 不碰外部区域）；中文 IME/选区/撤销/剪贴板全过 |
| A4 | 接现有 Rust Core | 输入 → Submit → Outbox Accepted → 轮次激活（对齐乙的 E2E 断言） |
| A5 | Dioxus Desktop | Native Core，跨平台宿主验收 |

**A2 失败预案**（计划原文已给）：先区分阻碍来自 React 专属 Plugin（可迁移）还是 Lexical 本身（不可行）——前者继续，后者回退计划乙产品线，editor-rs 实验线保留。

## 明确边界（计划原文已诚实标注，再次确认）

- Dioxus Desktop 仍是系统 WebView（WebView2/WKWebView/WebKitGTK），**不是 Gecko**——A+ 解决的是 Rust-first UI 与编辑器复用，不解决浏览器引擎替换。
- Dioxus 是 Rust UI 框架 ≠ Rust 接管浏览器输入法/contenteditable——原生编辑能力仍经 DOM API 由 Lexical 使用。
- 初期不用 Shadow DOM（避免 Selection/IME/剪贴板新变量），复用已验证的普通 DOM 结构。

## 乙资产的重新定位（不浪费已付成本）

| 乙资产 | A+ 中的新用途 |
| --- | --- |
| React+Lexical 实现 | Vanilla Controller 的参考实现 |
| B01–B32（34 项） | 编辑器行为验收基准（A2/A3 逐项复现） |
| 76 单元 + 14 变异 | 回归基准 |
| WASM Host + E2E 10/10 | 对照组（A4 验收断言直接复用） |
| Bridge BM05/BM07 | 继续冻结（协议不动） |
| app-web | 升级为产品 UI 主线起点 |
