# host-adapters.md（Host 适配器设计）

> Phase 3/4 交付物。每个 Host 实现同一 Composer Bridge 协议，但 Effect 执行方式不同。
> 决策链：D003（JSON 单一序列化路径）→ D004（WasmEngine 适配 + Effects 接力泵）→ 本文档。

## 1. 架构总览

```
UI 层（React 参考 / Dioxus 产品）
       |
Composer Bridge 协议（composer-bridge-protocol）
       |
+------|------+
|      |      |
Web WASM Host   Desktop Native Host
(wasm-bindgen)  (Tauri / Dioxus Desktop 直调)
|      |      |
IndexedDB       Native Storage (SQLite / 文件)
HTTP/回环       Tauri IPC / HTTP
```

## 2. Web WASM Host（composer-bridge-wasm）

### 2.1 导出面

```rust
#[wasm_bindgen]
impl WasmBridge {
    pub fn new(scope: String, state_json: Option<String>) -> Result<WasmBridge, JsValue>;
    pub fn snapshot(&self) -> String;           // SnapshotDto JSON
    pub fn dispatch(&mut self, event_json: &str) -> Result<String, JsValue>;
    pub fn ack(&mut self, ref_id: u32, outcome_json: &str) -> Result<String, JsValue>;
    pub fn pending_count(&self) -> u32;
    pub fn persist_revision(&self) -> u32;
}
```

### 2.2 Clock/IdGen 注入

- Clock = `js_sys::Date::now()`（改进路径：performance.now() 基准防回拨，D002 观察项）
- IdGen = 计数器 + `Math.random()` 前缀（多标签页不碰撞）

### 2.3 持久化（Phase 5）

- Persist Effect → IndexedDB CAS（`app-react/src/hosts/web/persist.ts`）
- ScopeState JSON 整体存取（Rust 形状，与构造恢复同形状）
- expectedRevision = `persist_revision()`（BridgeCore 计数器）
- ok=true → BridgeCore 递增；ok=false → 暂停 + 保留（FM14/23）

### 2.4 已知边界

- E2E 10/10（textarea 路径）+ Node 冒烟 18/18（island 路径）均为真实 Core
- Lexical Island 集成（Phase 3）：onmounted eval → createController → CustomEvent 桥 → web-sys 监听 → Signal 更新

## 3. Desktop Native Host（Phase 4/6，未实现）

### 3.1 Tauri 2（已被 Dioxus Desktop 替代——见 A+ 计划 §九）

~~Tauri IPC ↔ Native Core~~ → Dioxus Desktop 直调 Native Core。

### 3.2 Dioxus Desktop 路线

- Core 与 UI 同一 Rust 进程：直调（无 JSON 序列化）
- Island 仍经 JS（系统 WebView 中的 Lexical）——同 Web 路径
- 持久化：Native Storage（SQLite / 文件），不强迫 IndexedDB
- 平台能力（文件选择/剪贴板/拖放）：Dioxus Desktop API → Host Effect

## 4. ComposerEngine 适配面（app-react React 参考实现）

```rust
// EngineFace = Pick<ComposerEngine, "initialize"|"getSnapshot"|"subscribe"|...>
// WasmEngine 实现 EngineFace——组件调用点零改动
pub struct WasmEngine { ... }
impl EngineFace for WasmEngine { ... }  // TS 结构类型兼容
```

## 5. 持久化适配器接口

```ts
// app-react/src/hosts/web/persist.ts
export interface StatePersist {
  load(scope: string): Promise<string | null>;
  cas(scope: string, expectedRevision: number, stateJson: string): Promise<boolean>;
}
```

Desktop 等价物（Phase 4/6）：SQLite 或文件——同一接口形状。
