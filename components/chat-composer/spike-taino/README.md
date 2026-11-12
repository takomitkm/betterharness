# spike-taino（E0 评估产物，D014）

taino-edit 当 composer Pure Rust Editor 的评估 spike。**判据 9/9 全绿**（taino-e2e-criteria7.log）。

注意：`Cargo.toml` 的 `composer-keynav` path dep 指向校机布局
（`../composer-rust-3/crates/composer-keynav`）——在本机/其他环境复跑前需改指。
本 crate 是一次性评估产物，不进主 workspace 门禁（自带独立 [workspace]）。

复跑：`cargo build --release --target wasm32-unknown-unknown` → wasm-bindgen
（0.2.130）→ 静态服务 index.html → verify/spike-cdp.mjs（CE_BROWSER_CHANNEL=msedge）。
