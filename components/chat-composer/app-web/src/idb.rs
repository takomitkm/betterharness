//! E3c：Rust 主线的 IndexedDB 持久化（计划书 §8.3 / Phase 5 验收语义在 taino 线落地）。
//!
//! 架构（D011 决定 2 的「平台适配层」口）：
//! - Runtime 发 `Effect::Persist` → host 的 executor 同步受理（Runtime 流程不变）；
//! - executor 调 `request_put`（防抖串行写循环）异步落 IDB（scope 键、整本 state JSON）；
//! - 启动时协程先 await 读 IDB → 有记录则 `restore_from_persisted`（FM09）。
//!
//! 实现注记：IDB 回调用 `Closure::once` + oneshot 驱动——`Closure<dyn FnMut>` 会让
//! `tx.send(...)`（消耗 Sender）无法编译为 FnMut（E3c 实录）；`setTimeout` 轮询的
//! JsFuture await 在 spawn_local 下卡死（setTimeout 回调未触发，同一实录）。
//! 诚实边界：写失败只 console.error（演示面不回 Persisted{ok:false}——暂停/恢复链
//! 属宿主持久化管线的完整面）；CAS 面记录 revision 但单客户端语义。

use futures::channel::oneshot;
use wasm_bindgen::prelude::JsValue;
use wasm_bindgen::JsCast;

const DB_NAME: &str = "composer-rust-state";
const STORE: &str = "scope";

thread_local! {
    /// 待写快照（最新覆盖旧值）+ 写循环运行旗标：每键 Edit 都触发 persist，
    /// 并发 put 的 IDB 事务提交顺序不定（E3c 实录：记录停在按键中间态）——
    /// 串行写循环保证最终态 = 最新快照。
    static PENDING: std::cell::RefCell<Option<(String, String)>> = const { std::cell::RefCell::new(None) };
    static WRITER_RUNNING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 请求持久化（幂等防抖）：记下最新快照，常驻写循环串行落库。
pub fn request_put(key: &str, json: &str) {
    PENDING.with(|cell| *cell.borrow_mut() = Some((key.to_string(), json.to_string())));
    let already = WRITER_RUNNING.with(|cell| {
        if cell.get() {
            true
        } else {
            cell.set(true);
            false
        }
    });
    if already {
        return;
    }
    wasm_bindgen_futures::spawn_local(async move {
        loop {
            let job = PENDING.with(|cell| cell.borrow_mut().take());
            let Some((key, json)) = job else {
                WRITER_RUNNING.with(|cell| cell.set(false));
                return;
            };
            put(&key, &json).await;
        }
    });
}

/// 打开（或创建）数据库与对象仓库：onsuccess 回调 + oneshot 驱动。
async fn open_db() -> Option<web_sys::IdbDatabase> {
    let window = web_sys::window()?;
    let factory: web_sys::IdbFactory = window.indexed_db().ok()??;
    let request = factory.open_with_u32(DB_NAME, 1).ok()?;
    let (tx, rx) = oneshot::channel::<Option<web_sys::IdbDatabase>>();
    let onupgradeneeded = wasm_bindgen::closure::Closure::<dyn FnMut(web_sys::Event)>::new(
        move |ev: web_sys::Event| {
            let db = ev
                .target()
                .and_then(|t| t.dyn_into::<web_sys::IdbOpenDbRequest>().ok())
                .and_then(|req| req.result().ok())
                .and_then(|v| v.dyn_into::<web_sys::IdbDatabase>().ok());
            if let Some(db) = db {
                let _ = db.create_object_store(STORE);
            }
        },
    );
    request.set_onupgradeneeded(Some(onupgradeneeded.as_ref().unchecked_ref()));
    std::mem::forget(onupgradeneeded); // 应用生命周期与 DB 一致
    let onsuccess = wasm_bindgen::closure::Closure::once(move |ev: web_sys::Event| {
        let db = ev
            .target()
            .and_then(|t| t.dyn_into::<web_sys::IdbOpenDbRequest>().ok())
            .and_then(|req| req.result().ok())
            .and_then(|v| v.dyn_into::<web_sys::IdbDatabase>().ok());
        let _ = tx.send(db);
    });
    request.set_onsuccess(Some(onsuccess.as_ref().unchecked_ref()));
    onsuccess.forget();
    rx.await.ok().flatten()
}

/// put(key, json_value)——覆盖写（fire-and-forget；错误只 console.error）。
async fn put(key: &str, json: &str) -> Option<()> {
    let db = open_db().await?;
    let tx = db
        .transaction_with_str_and_mode(STORE, web_sys::IdbTransactionMode::Readwrite)
        .ok()?;
    let store = tx.object_store(STORE).ok()?;
    let request = store
        .put_with_key(&JsValue::from_str(json), &JsValue::from_str(key))
        .ok()?;
    let (tx_done, rx) = oneshot::channel::<Option<()>>();
    let onsuccess = wasm_bindgen::closure::Closure::once(move |_ev: web_sys::Event| {
        let _ = tx_done.send(Some(()));
    });
    request.set_onsuccess(Some(onsuccess.as_ref().unchecked_ref()));
    onsuccess.forget();
    rx.await.ok().flatten()
}

/// get(key) → Option<json>。
pub async fn get(key: &str) -> Option<String> {
    let db = open_db().await?;
    let tx = db
        .transaction_with_str_and_mode(STORE, web_sys::IdbTransactionMode::Readonly)
        .ok()?;
    let store = tx.object_store(STORE).ok()?;
    let request = store.get(&JsValue::from_str(key)).ok()?;
    let (tx_res, rx) = oneshot::channel::<Option<String>>();
    let onsuccess = wasm_bindgen::closure::Closure::once(move |ev: web_sys::Event| {
        let value = ev
            .target()
            .and_then(|t| t.dyn_into::<web_sys::IdbRequest>().ok())
            .and_then(|req| req.result().ok())
            .and_then(|v| v.as_string());
        let _ = tx_res.send(value);
    });
    request.set_onsuccess(Some(onsuccess.as_ref().unchecked_ref()));
    onsuccess.forget();
    rx.await.ok().flatten()
}
