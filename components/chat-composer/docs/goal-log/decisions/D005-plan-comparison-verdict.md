# D005：两版实施方向对比裁决——产品线用 React+Lexical 双 Host，Dioxus 降实验线

- **日期**：2026-11-12
- **状态**：已采纳（用户要求细则对比后裁决）
- **关联**：PRODUCT-LINE-PLAN.md（计划乙）；计划书第二次修订的 Dioxus-first 方向（计划甲）；D002/D003/D004

## 对比的两版计划

- **计划甲（Dioxus-first，第二次修订方向）**：一切 Rust——Dioxus 做 UI（Web=WASM / 桌面=WebView 壳），自研编辑器与附件交互，WASM Components 做外部插件，Cordis 思想 Rust 自实现。
- **计划乙（React+Lexical 双 Host，第三次修订 / PRODUCT-LINE-PLAN）**：Rust Core 唯一业务源；React+Lexical 产品 UI（复活 archive/ts）；统一 Bridge 协议；Web=WASM / Desktop=Tauri 2 Native 双 Host；Dioxus 降实验线。

## 细则对比（用已验证事实，不谈理念）

| 细则 | 计划甲（Dioxus-first） | 计划乙（React+Lexical 双 Host） | 裁决依据 |
| --- | --- | --- | --- |
| 富文本编辑器 | 自研或等 Dioxus 生态成熟——**目前不存在等价物** | Lexical 直接复活：IME/选区/撤销/剪贴板全踩过坑并已修（isMoveForward 掩码、内部选区滞后、editorState.read） | **乙，决定性**。编辑器是整个 Composer 风险最高的部件 |
| 已验证测试资产 | Rust 侧共用（94→101 项）；UI 侧 B01–B32 浏览器测试需等 UI 重写 | B01–B32 **已恢复并实测**（34/34）；E2E 10/10 已跑通首链 | **乙**。资产复活 vs 资产闲置 |
| 核心状态机 | 同一份 Rust Core（两版共用） | 同左 | 平手 |
| 插件体系 | 同一份 plugin-api/composition（两版共用） | 同左 | 平手 |
| 语言/类型统一 | **甲优**：全 Rust 单语言 | 双运行时（WASM 引擎 + JS UI），桥面 JSON 协议需双侧维护 | 甲的理论优势；但 Bridge 形状已冻结（BM05 契约测试），成本被约束在窄协议面 |
| 跨平台 UI | 一份 rsx 适配多平台（WebView 渲染） | Tauri 2 也是系统 WebView（WebView2/WKWebView/WebKitGTK）——同样是“多壳一前端” | 平手（渲染路线都未定死，计划书 §7） |
| 中文 IME 风险 | Dioxus 编辑器路线**未验证**（性能原型清单第一项） | Lexical 在 Edge 实测通过（B12 组合输入 + E2E） | **乙** |
| 到产品的时间 | 编辑器自研 = 数月级不确定 | 首链**已通**（E2E 10/10，真实 WASM Core） | **乙** |
| 退出成本 | UI 框架无关协议已冻结（Bridge/D003） | 同左 | 平手——换 UI 不重写核心是两版共同的保证 |
| WASM 兼容门 | 同左 | 已过（10/10 crate wasm32 编译） | 平手 |

## 裁决

1. **产品线 = 计划乙**。决定性依据不是理念而是两个硬事实：Lexical 是唯一被真机锤过的编辑器（换任何方案都要重踩 IME/选区/撤销）；乙的首链已经真实跑通而甲的编辑器尚不存在。
2. **实验线 = 计划甲继续**。app-web（Dioxus）保留；Blitz/Dioxus 编辑器成熟后按性能原型清单（中文 IME、流式 Markdown、长文档虚拟化、插件开销）打分，过线再谈产品线切换。
3. **切换条件预先写死**（避免凭感觉反复）：Dioxus 生态出现能通过「中文 IME + 正文内附件混排 + 撤销栈」三件的编辑器，且性能原型达标——届时 Bridge 协议不动，只换 UI 适配层。
4. **共同不变式不受裁决影响**：Cordis 插件体系、Capability Seam、Profile/Bundle/Patch、Durable/Live 边界——两版计划在这一层完全一致，这正是“换框架不重写核心”的结构保证。

## 与既有决定的关系

- 不推翻 D002/D003/D004（Bridge 协议、JSON 单路、WasmEngine）——它们服务计划乙且已验证。
- 计划书第三次修订（§9 产品线定案）与本裁决一致；本文件补充“为什么甲输了产品线但保留实验线”的完整依据。
