//! Composer Bridge 的 Web WASM Host（PRODUCT-LINE-PLAN Phase 3）。
//!
//! 决定 D003：**桥面 = JSON 字符串单一序列化路径**——与 Tauri IPC（Desktop）完全同构，
//! 跨 Host 对拍（conformance）只比对 JSON；不展开 wasm-bindgen 结构体（两条序列化路径
//! 会让 Web/Desktop 的协议漂移）。Clock/IdGen 由本 Host 注入（BridgeCore 的注入设计）：
//! Clock = js_sys::Date::now()（回拨风险与 performance.now 改进记录在 D002/D003），
//! IdGen = 计数器 + Math.random 前缀。
//!
//! 持久化：scope 状态经 IndexedDB（JS 侧）以 ScopeState JSON 存取——构造时传
//! `Some(state_json)` 恢复（FM09：sending→unknown），None 全新会话。Persist Effect
//! 的回执（IndexedDB CAS 写入结果）经 ack(Persisted{ok}) 回填——与 TS store 的
//! revision CAS 语义一致（asset-inventory §4）。
//!
//! 构建与冒烟：
//!   cargo build --release --target wasm32-unknown-unknown
//!   wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/composer_bridge_wasm.wasm
//!   node verify/wasm-smoke.mjs

use composer_bridge_protocol::{BridgeCore, ComposerEventDto, EffectOutcomeDto};
use composer_core::ids::{GenerationId, ScopeId};
use composer_core::state::ScopeState;
use composer_runtime::RuntimeConfig;
use wasm_bindgen::prelude::*;

/// Web 宿主桥：一个实例 = 一个 composer 会话（scope）。
#[wasm_bindgen]
pub struct WasmBridge {
    core: BridgeCore,
    seq: u64,
}

#[wasm_bindgen]
impl WasmBridge {
    /// 构造。scope = 会话身份（回执 receipt.scope 必须与之一致，否则 IdentityMismatch
    /// → uncertain——宿主配错身份时 FM15 的纪律正确兜底，D004 实录）。
    /// state_json = Some(持久化的 ScopeState JSON) 恢复（FM09）；None 全新。
    #[wasm_bindgen(constructor)]
    pub fn new(scope: String, state_json: Option<String>) -> Result<WasmBridge, JsValue> {
        let scope = ScopeId::new(scope);
        let config = RuntimeConfig {
            scope: scope.clone(),
            send_timeout_ms: 1500,
        };
        let state = match state_json {
            Some(json) => serde_json::from_str::<ScopeState>(&json)
                .map_err(|error| JsValue::from(format!("invalid persisted state: {error}")))?,
            None => ScopeState::new(scope, GenerationId::new("gen-0")),
        };
        let core = BridgeCore::new(config, state, Box::new(now_ms), Box::new(next_id));
        Ok(WasmBridge { core, seq: 0 })
    }

    /// 当前完整快照（SnapshotDto JSON）。
    pub fn snapshot(&self) -> String {
        serde_json::to_string(&self.core.snapshot()).expect("snapshot serializes")
    }

    /// 派发 UI 事件（ComposerEventDto JSON）→ DispatchResultDto JSON。
    pub fn dispatch(&mut self, event_json: &str) -> Result<String, JsValue> {
        let event: ComposerEventDto = serde_json::from_str(event_json)
            .map_err(|error| JsValue::from(format!("invalid event: {error}")))?;
        Ok(serde_json::to_string(&self.core.dispatch(event)).expect("result serializes"))
    }

    /// Effect 回执（ref_id + EffectOutcomeDto JSON）→ DispatchResultDto JSON。
    /// UnknownRef/OutcomeMismatch 以 Err 字符串返回（JS 侧按异常处理）。
    pub fn ack(&mut self, ref_id: u32, outcome_json: &str) -> Result<String, JsValue> {
        let outcome: EffectOutcomeDto = serde_json::from_str(outcome_json)
            .map_err(|error| JsValue::from(format!("invalid outcome: {error}")))?;
        self.core
            .ack(ref_id as u64, outcome)
            .map(|result| serde_json::to_string(&result).expect("result serializes"))
            .map_err(|error| JsValue::from(format!("{error:?}")))
    }

    /// 未回执引用数（诊断/卸载前检查）。
    pub fn pending_count(&self) -> u32 {
        self.core.pending_effect_count() as u32
    }
}

fn now_ms() -> u64 {
    js_sys::Date::now() as u64
}

fn next_id() -> String {
    // 计数器 + 随机前缀：多标签页/多实例不碰撞；Core 不感知生成方式（IdGen 注入）。
    thread_local! {
        static SEQ: std::cell::Cell<u64> = std::cell::Cell::new(0);
    }
    let seq = SEQ.with(|cell| {
        let next = cell.get() + 1;
        cell.set(next);
        next
    });
    let random = (js_sys::Math::random() * 4_294_967_295.0) as u32;
    format!("w-{random:08x}-{}", seq)
}
