//! composer-core：可靠提交台账（Shared Rust Core 的消息引擎层）。
//!
//! 自旧 Rust 参考核心（archive/rust）吸收而来，语义对齐 archive/ts/core.ts：
//! 持久 outbox、unknown 永不自动重发、回执只结算自己的消息、queue/steer 轮次推进、
//! 逐条取回。字节的持有与 IndexedDB/HTTP 属于平台适配层，不进本 crate。
//!
//! 旧的 wasm-bindgen 导出（archive/rust/src/wasm.rs）已被 Dioxus web 运行时取代：
//! Web 目标下整个 core 直接编译进应用 WASM，不再单独暴露 JS 门面。

pub mod ids;
pub mod state;
