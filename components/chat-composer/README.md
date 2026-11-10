# chat-composer（Rust-first 重构版）

按 [`../README.md`](../README.md) 计划书重建的聊天输入框：**Shared Rust Core + 细粒度规则组件 + 插件组合引擎**，
UI 走 Dioxus。旧 TypeScript 实现与旧 Rust 参考核心封存在 [`archive/`](archive/)（含其行为契约与测试清单）。

许可证：GPL-3.0（与仓库 LICENSE 一致）。

## 目录

```
crates/
  composer-core/          可靠提交台账：持久 outbox、unknown 永不自动重发、queue/steer 轮次推进、逐条取回
  composer-keynav/        Enter/IME 仲裁：组合保护 + 10ms 宽限窗 + 菜单/重复/提交优先级
  composer-completion/    候选菜单：@// 触发检测、代次防过期、一次选择一次撤销
  composer-intake/        统一文件准入：整批/逐文件策略、粘贴路由判定
  composer-reorder/       附件移动跨度：目标下标钳制、同位无操作
  composer-snapshot/      有序文档与附件身份校验、节点摘除
  composer-plugin-api/    插件贡献协议（命令 + UI 槽位描述，UI 框架无关）
  composer-composition/   组合引擎：TOML 清单 → 槽位计划（组件重组层，无需重编译）
plugins/
  attachment-tools/       内置插件：alt 替代文本、压缩/原图开关、前移/后移（示范贡献机制）
app-web/                  Dioxus 0.7 web 演示面板（独立 workspace，不进主门禁）
```

## 测试与门禁

```sh
cargo test --workspace          # 78 项原生测试（校机门禁第一步）
cargo build --release           # release 构建检查
cd app-web
cargo check --target wasm32-unknown-unknown   # Web Runtime 编译级验证
```

测试名与 archive/ts 的旧测试一一对应（KD/CT/IT/RO/FM/FD 序列），语义逐条移植并有对拍。

## 插件机制（计划书 §3 的落地）

插件贡献**命令与 UI 描述**，不直接操纵 UI。`attachment-tools` 是样板：

```rust
impl Plugin for AttachmentToolsPlugin {
    fn id(&self) -> &'static str { "attachment-tools" }
    fn register(&self, registry: &mut Registry) {
        registry.register_command("attachment.alt.set", Arc::new(SetAltText))?;
        registry.register_view(self.id(), ViewContribution {
            slot: SlotId("attachment.card.tools".into()),
            component: "toggle-button".into(),
            label: "压缩/原图".into(),
            action: Some(CommandId("attachment.send-as-file.toggle".into())),
            ..Default::default()
        });
    }
}
```

宿主在卡片上提供 `attachment.card.tools` 挂载点，PluginSlot 按 Registry 的贡献渲染；
用户点击触发命令，命令调 composer-reorder 等细组件完成实际工作。
**组件重组**：改 TOML 清单即可重排/禁用贡献，无需重编译主程序（composer-composition）。

## app-web 演示面板

- 接线 composer-core 台账真实状态：草稿编辑、可靠提交（交接 + 后继空草稿）、
  轮次推进（结束本轮后派发排队消息）、逐条取回、拒绝重试。
- Enter/IME 仲裁接 composer-keynav：组合中的 Enter 交给输入法，绝不误发。
- 传输为本地回环（立刻接纳），HTTP/IndexedDB 适配层随后接入；当前状态仅存活于页面内存。
- 运行需 dx/trunk 打包；CI 目前做 wasm32 编译级验证（诚实缺席：未做端到端浏览器运行）。

## 路线（对齐计划书）

1. 平台适配层：IndexedDB CAS 存储、HTTP 回执传输接入 composer-core 的持久化边界。
2. 外部 WASM 插件宿主：Component Model / WIT 接口 + Wasmtime（浏览器与原生宿主的加载差异见计划书 §2B）。
3. app-web 端到端：dx 打包进 CI，浏览器级中文输入法矩阵测试。
4. Dioxus Native 渲染路线评估（实验性，见计划书 §5 性能原型清单）。
