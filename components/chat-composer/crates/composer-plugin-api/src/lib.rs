//! Cordis 式插件运行时（计划书 §1/§4 的 Composition Runtime 内核）——Rust 重实现，
//! 保留 Cordis 的 Context / Service / inject / Fiber / Reversible Effects / Typed Events 模型：
//!
//! - **一切皆服务**：[`Context`] 按类型提供/查找；能力接缝（Capability Seam，DSH 模式 A）
//!   用 trait 对象做 Service Definition——`provide::<dyn Storage>(Arc::new(impl))`，
//!   消费方 `capability::<dyn Storage>()`，实现可替换（Provider A/B），消费方不感知；
//! - **Fiber 响应式激活**：插件实例（Fiber）声明 `requires`（inject）；依赖缺席 → 等待态
//!   （激活闭包挂起，不崩溃）；服务出现 → 自动重放激活；服务被撤 → 相关 Fiber 级联回滚
//!   （副作用全部回收）→ 回到等待态；服务再出现 → 重新激活（全新实例）；
//! - **可逆副作用**：激活期间经 [`Scope`] 做的每一次注册（服务、命令、槽位、事件订阅、
//!   任意清理钩子）都登记进 Fiber，卸载/回滚按 LIFO 全部回收（RAII/Disposer）；
//! - **Typed Event Bus（Live）**：运行时事件解耦协作；持久事实（Session Events）不属于
//!   总线——事件总线不可以当数据库（DSH 模式 C 的边界）；
//! - 同类型服务唯一；apply 失败的 Fiber 完整回滚并显式报错（DSH：失败 bundle 留列表报错）。
//!
//! 边界（计划书 §5）：本 crate 不解决进程隔离、跨语言 ABI、跨平台编译——那些由
//! WASM Components（WIT/Wasmtime）承担；本 crate 的形状就是宿主侧权威协议。

use serde_json::Value;
use std::any::{Any, TypeId};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};

// ————— 服务容器（Context / Capability Seam） —————

/// 服务标记：可跨插件共享、按类型定位。能力接口（trait）声明 `: Service` 即可
/// 以 trait 对象形态进容器（Capability Seam 的 Service Definition）。
pub trait Service: Any + Send + Sync {}

/// 服务容器。键 = `TypeId::of::<T>()`，T 可以是 Sized 服务也可以是 trait 对象（能力）。
#[derive(Default)]
pub struct Context {
    services: BTreeMap<TypeId, Arc<dyn Any + Send + Sync>>,
}

impl Context {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert<T: ?Sized + 'static + Send + Sync>(&mut self, value: Arc<T>) -> Result<(), String> {
        let key = TypeId::of::<T>();
        if self.services.contains_key(&key) {
            return Err(format!("service already provided: {}", type_name_of::<T>()));
        }
        // Arc<T> 本身是 Sized：擦除句柄而非被指对象（trait 对象也能进容器）。
        let erased: Arc<dyn Any + Send + Sync> = Arc::new(value);
        self.services.insert(key, erased);
        Ok(())
    }

    pub(crate) fn take_raw(&mut self, key: TypeId) -> bool {
        self.services.remove(&key).is_some()
    }

    pub fn contains<T: ?Sized + 'static + Send + Sync>(&self) -> bool {
        self.services.contains_key(&TypeId::of::<T>())
    }

    pub(crate) fn contains_raw(&self, key: TypeId) -> bool {
        self.services.contains_key(&key)
    }

    /// 提供一个服务；同类型重复提供显式报错（服务唯一性，cordis 语义）。
    pub fn provide<T: ?Sized + 'static + Send + Sync>(
        &mut self,
        value: Arc<T>,
    ) -> Result<(), String> {
        self.insert(value)
    }

    /// 查找服务。
    pub fn get<T: ?Sized + 'static + Send + Sync>(&self) -> Option<Arc<T>> {
        // 容器里存的是 Arc<Arc<T>>（句柄的句柄）。downcast_ref 借用后 clone 引用计数，
        // 避免 Arc::downcast 的所有权推断把目标类型吸成 Arc<Arc<T>>。
        let any = self.services.get(&TypeId::of::<T>())?;
        let handle: &Arc<T> = any.downcast_ref::<Arc<T>>().expect("typed by key");
        Some(handle.clone())
    }
}

fn type_name_of<T: ?Sized + 'static>() -> &'static str {
    std::any::type_name::<T>()
}

// ————— 内建服务（Mutex 内部可变：多个 Fiber 共享注册） —————

/// 命令实现：payload 进、结果出，都是 JSON（跨插件边界用 JSON，与未来 WIT 对齐）。
pub trait CommandHandler: Send + Sync {
    fn invoke(&self, payload: &Value) -> Result<Value, String>;
}

/// 命令服务（≈ DSH ctx.tools）：行为入口注册表。
#[derive(Default)]
pub struct Commands {
    handlers: Mutex<BTreeMap<String, Arc<dyn CommandHandler>>>,
}

impl Commands {
    pub fn register(&self, id: &str, handler: Arc<dyn CommandHandler>) -> Result<(), String> {
        let mut handlers = self.handlers.lock().unwrap();
        if handlers.contains_key(id) {
            return Err(format!("command already registered: {id}"));
        }
        handlers.insert(id.to_string(), handler);
        Ok(())
    }

    pub fn handler(&self, id: &str) -> Option<Arc<dyn CommandHandler>> {
        self.handlers.lock().unwrap().get(id).cloned()
    }

    pub fn ids(&self) -> Vec<String> {
        self.handlers.lock().unwrap().keys().cloned().collect()
    }
}

impl Service for Commands {}

/// UI 贡献的挂载点。宿主声明类型化槽位（DSH：conversation.input.* 契约槽），
/// 插件把组件描述贡献进来，宿主 PluginSlot 渲染。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SlotId(pub String);

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CommandId(pub String);

/// UI 描述：组件名 + 属性交给宿主 PluginSlot，插件不直接渲染。
#[derive(Clone, Debug, PartialEq)]
pub struct ViewContribution {
    pub slot: SlotId,
    pub component: String,
    pub label: String,
    pub action: Option<CommandId>,
    pub props: Value,
    /// 同槽位内的排序权重，小者在前；同权重按注册顺序。
    pub order: i32,
    pub plugin: String,
}

/// 槽位服务（≈ ui-cordis 的 register slots）。
#[derive(Default)]
pub struct Slots {
    views: Mutex<Vec<ViewContribution>>,
    plugins: Mutex<Vec<String>>,
}

impl Slots {
    pub fn register_view(&self, plugin: &str, view: ViewContribution) {
        let mut view = view;
        view.plugin = plugin.to_string();
        self.views.lock().unwrap().push(view);
    }

    /// 某槽位的全部贡献，按 (order, 注册顺序) 稳定排序。
    pub fn slot_views(&self, slot: &str) -> Vec<ViewContribution> {
        let mut views: Vec<ViewContribution> = self
            .views
            .lock()
            .unwrap()
            .iter()
            .filter(|view| view.slot.0 == slot)
            .cloned()
            .collect();
        views.sort_by_key(|view| view.order);
        views
    }

    pub fn note_plugin(&self, id: &str) {
        self.plugins.lock().unwrap().push(id.to_string());
    }

    pub fn views(&self) -> Vec<ViewContribution> {
        self.views.lock().unwrap().clone()
    }

    pub fn plugins(&self) -> Vec<String> {
        self.plugins.lock().unwrap().clone()
    }
}

impl Service for Slots {}

/// 触发种类：@ = reference，/ = slash（语义与 composer-completion 对齐）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriggerKind {
    Reference,
    Slash,
}

/// 候选来源描述（≈ ui-input-trigger 的 registerSource）。
#[derive(Clone)]
pub struct CompletionSource {
    pub name: String,
    pub triggers: Vec<TriggerKind>,
    /// 同步取候选（v1）；异步来源由宿主预取后注入，代次守卫在 composer-completion。
    pub fetch: Arc<dyn Fn(&str) -> Vec<CandidateDto> + Send + Sync>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateDto {
    pub label: String,
    pub insert_text: String,
}

/// 候选来源服务。
#[derive(Default)]
pub struct CompletionSources {
    sources: Mutex<Vec<CompletionSource>>,
}

impl CompletionSources {
    pub fn register(&self, source: CompletionSource) {
        self.sources.lock().unwrap().push(source);
    }

    pub fn for_trigger(&self, trigger: TriggerKind) -> Vec<CompletionSource> {
        self.sources
            .lock()
            .unwrap()
            .iter()
            .filter(|source| source.triggers.contains(&trigger))
            .cloned()
            .collect()
    }

    pub fn names(&self) -> Vec<String> {
        self.sources
            .lock()
            .unwrap()
            .iter()
            .map(|source| source.name.clone())
            .collect()
    }
}

impl Service for CompletionSources {}

// ————— Typed Event Bus（Live 事件；持久事实走 Storage，不走总线） —————

/// Live 事件标记：任何 'static + Send + Sync 类型都是 Live 事件。
pub trait LiveEvent: Any + Send + Sync + 'static {}
impl<T: Any + Send + Sync + 'static> LiveEvent for T {}

type ErasedHandler = Arc<dyn Fn(&dyn Any) + Send + Sync>;

/// 类型化事件总线：按事件类型分发；订阅经 Scope 登记为可逆副作用。
#[derive(Default)]
pub struct EventBus {
    handlers: Mutex<BTreeMap<TypeId, Vec<(u64, ErasedHandler)>>>,
    next_token: Mutex<u64>,
}

impl EventBus {
    /// 订阅并返回可逆令牌（Scope 会把它登记成 Disposer）。
    pub fn subscribe<E: LiveEvent>(&self, handler: Arc<dyn Fn(&E) + Send + Sync>) -> u64 {
        let token = {
            let mut next = self.next_token.lock().unwrap();
            *next += 1;
            *next
        };
        let erased: ErasedHandler = Arc::new(move |any: &dyn Any| {
            let typed = any.downcast_ref::<E>().expect("typed publish");
            handler(typed);
        });
        self.handlers
            .lock()
            .unwrap()
            .entry(TypeId::of::<E>())
            .or_default()
            .push((token, erased));
        token
    }

    pub fn unsubscribe(&self, token: u64) {
        let mut handlers = self.handlers.lock().unwrap();
        for (_, entries) in handlers.iter_mut() {
            entries.retain(|(entry_token, _)| entry_token != &token);
        }
    }

    pub fn publish<E: LiveEvent>(&self, event: &E) {
        let handlers = self.handlers.lock().unwrap();
        if let Some(entries) = handlers.get(&TypeId::of::<E>()) {
            for (_, handler) in entries {
                handler(event);
            }
        }
    }
}

impl Service for EventBus {}

// ————— Fiber（插件实例生命周期） —————

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FiberId(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FiberStatus {
    /// 依赖缺席，等待激活（激活闭包挂起，不崩溃）。
    Waiting,
    /// 已激活：副作用在册。
    Active,
    /// 已卸载/回滚；依赖恢复后可重新激活（挂起的激活闭包被重放）。
    Retired,
}

impl fmt::Display for FiberStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FiberStatus::Waiting => f.write_str("waiting"),
            FiberStatus::Active => f.write_str("active"),
            FiberStatus::Retired => f.write_str("retired"),
        }
    }
}

type Disposer = Box<dyn FnOnce() + Send>;
type PendingApply = Box<dyn FnOnce(&mut Scope) -> Result<(), String> + Send>;

/// 一个插件实例：inject 声明、状态、可逆副作用登记、挂起的激活闭包。
struct Fiber {
    id: FiberId,
    plugin: &'static str,
    requires: Vec<TypeId>,
    status: FiberStatus,
    /// 本 Fiber 提供过的服务类型（回滚时移除，触发下游级联回滚）。
    provided: Vec<TypeId>,
    /// 可逆副作用：LIFO 回收。
    disposers: Vec<(&'static str, Disposer)>,
    /// 依赖缺席/级联回滚后挂起的激活闭包（依赖恢复即重放）。
    pending_apply: Option<PendingApply>,
}

/// 激活期间的注册句柄：每一次注册都登记进 Fiber（可逆副作用）。
pub struct Scope<'a> {
    fiber: &'a mut Fiber,
    context: &'a mut Context,
}

impl Scope<'_> {
    /// 提供服务（记录为可逆副作用：Fiber 回滚时移除并触发下游级联）。
    pub fn provide<T: ?Sized + 'static + Send + Sync>(
        &mut self,
        value: Arc<T>,
    ) -> Result<(), String> {
        let key = TypeId::of::<T>();
        self.context.insert(value)?;
        self.fiber.provided.push(key);
        Ok(())
    }

    /// 任意清理钩子（外部资源：自启动的服务器、计时器等由插件自带清理逻辑）。
    pub fn on_dispose(&mut self, what: &'static str, disposer: impl FnOnce() + Send + 'static) {
        self.fiber.disposers.push((what, Box::new(disposer)));
    }

    /// 订阅 Live 事件（可逆：Fiber 回滚时自动退订）。
    pub fn subscribe<E: LiveEvent>(&mut self, handler: Arc<dyn Fn(&E) + Send + Sync>) {
        let bus = self.context.get::<EventBus>().expect("built-in service");
        let token = bus.subscribe::<E>(handler);
        self.fiber
            .disposers
            .push(("event-bus", Box::new(move || bus.unsubscribe(token))));
    }

    /// 内建服务便捷访问（Loader 预置，必定存在）。
    pub fn commands(&self) -> Arc<Commands> {
        self.context.get::<Commands>().expect("built-in service")
    }

    pub fn slots(&self) -> Arc<Slots> {
        self.context.get::<Slots>().expect("built-in service")
    }

    pub fn completion_sources(&self) -> Arc<CompletionSources> {
        self.context
            .get::<CompletionSources>()
            .expect("built-in service")
    }

    /// 能力接缝消费：必需的能力（trait 对象服务）缺失时显式报错。
    pub fn capability<T: ?Sized + 'static + Send + Sync>(&self) -> Result<Arc<T>, String> {
        self.context
            .get::<T>()
            .ok_or_else(|| format!("capability missing: {}", type_name_of::<T>()))
    }
}

/// Fiber 装载声明（inject）：插件名 + 依赖的服务类型。
#[derive(Clone)]
pub struct FiberSpec {
    pub plugin: &'static str,
    pub requires: Vec<TypeId>,
}

impl FiberSpec {
    pub fn new(plugin: &'static str) -> Self {
        FiberSpec {
            plugin,
            requires: Vec::new(),
        }
    }

    /// 声明依赖（inject）：依赖缺席时挂起激活。
    pub fn requires<T: ?Sized + 'static + Send + Sync>(mut self) -> Self {
        self.requires.push(TypeId::of::<T>());
        self
    }
}

/// 可装载组件（DSH bundle 语义的 Rust 形态）：把自身挂载为 Loader 的一个 Fiber。
/// 深度原生扩展 = 实现本 trait 的 crate；外部 WASM 插件将来经 WIT 适配到同一入口。
pub trait Mountable: Send + Sync {
    fn id(&self) -> &'static str;
    fn mount(&self, loader: &mut Loader) -> Result<FiberId, String>;
}

/// 插件装载器（≈ Cordis Loader + Fiber 生命周期 + 依赖响应式激活）。
pub struct Loader {
    context: Context,
    fibers: Vec<Fiber>,
    next_fiber_id: u64,
}

impl Default for Loader {
    fn default() -> Self {
        Self::new()
    }
}

impl Loader {
    pub fn new() -> Self {
        let mut loader = Loader {
            context: Context::new(),
            fibers: Vec::new(),
            next_fiber_id: 0,
        };
        loader
            .context
            .provide(Arc::new(Commands::default()))
            .expect("fresh loader");
        loader
            .context
            .provide(Arc::new(Slots::default()))
            .expect("fresh loader");
        loader
            .context
            .provide(Arc::new(CompletionSources::default()))
            .expect("fresh loader");
        loader
            .context
            .provide(Arc::new(EventBus::default()))
            .expect("fresh loader");
        loader
    }

    pub fn context(&self) -> &Context {
        &self.context
    }

    /// 宿主直接提供服务（平台能力：Web/原生适配层在装载消费方之前提供）。
    /// 提供后立即激活新满足条件的等待 Fiber。
    pub fn provide<T: ?Sized + 'static + Send + Sync>(
        &mut self,
        value: Arc<T>,
    ) -> Result<(), String> {
        self.context.insert(value)?;
        self.activate_eligible();
        Ok(())
    }

    /// 宿主移除一个服务（能力被替换/下线）：依赖它的活跃 Fiber 级联回滚到等待态。
    pub fn remove<T: ?Sized + 'static + Send + Sync>(&mut self) -> bool {
        let removed = self.context.take_raw(TypeId::of::<T>());
        if !removed {
            return false;
        }
        self.cascade_from(&[TypeId::of::<T>()]);
        true
    }

    /// 装载一个插件实例。依赖缺席 → Waiting（Ok 返回，激活闭包挂起）；依赖齐备 → 激活。
    /// apply 失败 → 完整回滚 + 显式错误。
    pub fn mount(
        &mut self,
        spec: FiberSpec,
        apply: impl FnOnce(&mut Scope) -> Result<(), String> + Send + 'static,
    ) -> Result<FiberId, String> {
        self.next_fiber_id += 1;
        let fiber_id = FiberId(self.next_fiber_id);
        self.fibers.push(Fiber {
            id: fiber_id,
            plugin: spec.plugin,
            requires: spec.requires,
            status: FiberStatus::Waiting,
            provided: Vec::new(),
            disposers: Vec::new(),
            pending_apply: None,
        });
        if self.requirements_met(&self.find(fiber_id).requires) {
            run_apply(&mut self.context, &mut self.fibers, fiber_id, apply)?;
            self.activate_eligible();
        } else {
            // 依赖缺席：挂起激活动作（不崩溃），依赖补齐后自动重放。
            self.find_mut(fiber_id).pending_apply = Some(Box::new(apply));
        }
        Ok(fiber_id)
    }

    /// 卸载一个 Fiber：副作用 LIFO 全部回收；其提供的服务移除；依赖这些服务的
    /// 活跃 Fiber 级联回滚到等待态（依赖响应式激活的反向）。被 retire 的 Fiber 的
    /// 激活闭包挂回 pending_apply——依赖恢复后可重新激活（cordis 可逆语义）。
    pub fn retire(&mut self, fiber_id: FiberId) {
        let removed = self.rollback_fiber(fiber_id);
        if !removed.is_empty() {
            self.cascade_from(&removed);
        }
    }

    pub fn fibers(&self) -> Vec<(FiberId, &'static str, FiberStatus)> {
        self.fibers
            .iter()
            .map(|fiber| (fiber.id, fiber.plugin, fiber.status))
            .collect()
    }

    pub fn fiber_status(&self, fiber_id: FiberId) -> Option<FiberStatus> {
        self.fibers
            .iter()
            .find(|fiber| fiber.id == fiber_id)
            .map(|fiber| fiber.status)
    }

    fn find(&self, fiber_id: FiberId) -> &Fiber {
        self.fibers
            .iter()
            .find(|fiber| fiber.id == fiber_id)
            .expect("fiber mounted")
    }

    fn find_mut(&mut self, fiber_id: FiberId) -> &mut Fiber {
        self.fibers
            .iter_mut()
            .find(|fiber| fiber.id == fiber_id)
            .expect("fiber mounted")
    }

    fn requirements_met(&self, requires: &[TypeId]) -> bool {
        requires
            .iter()
            .all(|required| self.context.contains_raw(*required))
    }

    /// 激活补齐了别的等待 Fiber 的依赖：级联激活（工作循环，防借用递归）。
    fn activate_eligible(&mut self) {
        loop {
            let eligible: Vec<FiberId> = self
                .fibers
                .iter()
                .filter(|fiber| {
                    fiber.status == FiberStatus::Waiting && self.requirements_met(&fiber.requires)
                })
                .map(|fiber| fiber.id)
                .collect();
            if eligible.is_empty() {
                return;
            }
            for fiber_id in eligible {
                let Some(apply) = self.find_mut(fiber_id).pending_apply.take() else {
                    continue;
                };
                // 重放失败与挂载失败同纪律：Fiber 已完整回滚，错误显式留存。
                let _ = run_apply(&mut self.context, &mut self.fibers, fiber_id, apply);
            }
        }
    }

    /// 级联回滚：活跃 Fiber 的 requires 命中被移除的服务类型 → 回滚到等待态。
    /// 回滚的 Fiber 的激活闭包挂回 pending_apply——依赖恢复后重新激活。
    fn cascade_from(&mut self, removed: &[TypeId]) {
        loop {
            let cascade: Vec<FiberId> = self
                .fibers
                .iter()
                .filter(|fiber| {
                    fiber.status == FiberStatus::Active
                        && fiber
                            .requires
                            .iter()
                            .any(|required| removed.contains(required))
                })
                .map(|fiber| fiber.id)
                .collect();
            if cascade.is_empty() {
                return;
            }
            for fiber_id in cascade {
                let removed_by_fiber = self.rollback_fiber(fiber_id);
                if removed_by_fiber.is_empty() {
                    return;
                }
            }
        }
    }

    fn rollback_fiber(&mut self, fiber_id: FiberId) -> Vec<TypeId> {
        let Some(position) = self.fibers.iter().position(|fiber| fiber.id == fiber_id) else {
            return Vec::new();
        };
        let fiber = &mut self.fibers[position];
        if fiber.status == FiberStatus::Retired {
            return Vec::new();
        }
        // 副作用 LIFO 回收（可逆副作用核心）。
        while let Some((_, disposer)) = fiber.disposers.pop() {
            disposer();
        }
        // 移除其提供的服务。
        let provided = std::mem::take(&mut fiber.provided);
        for type_id in &provided {
            self.context.take_raw(*type_id);
        }
        // 状态：mount 时因依赖缺席挂起的闭包还在 = 依赖恢复后可重放（Waiting）；
        // 激活成功过的 Fiber 闭包已消费（FnOnce），回滚 = Retired 终态，
        // 重新激活 = 宿主再次 mount（诚实缺席，不伪造可重放）。
        fiber.status = if fiber.pending_apply.is_some() {
            FiberStatus::Waiting
        } else {
            FiberStatus::Retired
        };
        provided
    }
}

/// 激活一个 Fiber：拆借用跑 apply；失败即完整回滚（副作用 LIFO + 服务移除）。
/// 挂起闭包的重放语义由调用方管理（级联回滚会重新挂回）。
fn run_apply(
    context: &mut Context,
    fibers: &mut Vec<Fiber>,
    fiber_id: FiberId,
    apply: impl FnOnce(&mut Scope) -> Result<(), String>,
) -> Result<(), String> {
    let fiber = fibers
        .iter_mut()
        .find(|fiber| fiber.id == fiber_id)
        .expect("fiber mounted");
    fiber.status = FiberStatus::Active;
    let mut scope = Scope { fiber, context };
    let result = apply(&mut scope);
    drop(scope);
    if let Err(error) = result {
        let fiber = fibers
            .iter_mut()
            .find(|fiber| fiber.id == fiber_id)
            .expect("fiber mounted");
        fiber.status = FiberStatus::Retired;
        while let Some((_, disposer)) = fiber.disposers.pop() {
            disposer();
        }
        let provided = std::mem::take(&mut fiber.provided);
        for type_id in &provided {
            context.take_raw(*type_id);
        }
        return Err(format!("插件 {} 激活失败: {error}", fiber.plugin));
    }
    Ok(())
}

/// FiberSpec 的便捷构造：声明依赖链（inject）。
pub fn fiber(plugin: &'static str) -> FiberSpec {
    FiberSpec::new(plugin)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    // —— 能力接缝的 Service Definition（trait 对象服务） ——
    trait Storage: Service {
        fn put(&self, key: &str, value: &str);
        fn read(&self, key: &str) -> Option<String>;
    }

    #[derive(Default)]
    struct MemStorage {
        map: Mutex<BTreeMap<String, String>>,
    }
    impl Service for MemStorage {}

    impl Storage for MemStorage {
        fn put(&self, key: &str, value: &str) {
            self.map.lock().unwrap().insert(key.into(), value.into());
        }
        fn read(&self, key: &str) -> Option<String> {
            self.map.lock().unwrap().get(key).cloned()
        }
    }

    /// 一切皆服务：Sized 与 trait 对象（能力）同容器；同类型唯一。
    #[test]
    fn service_container_sized_and_capability() {
        let mut ctx = Context::new();
        ctx.provide(Arc::new(Commands::default())).unwrap();
        assert!(
            ctx.provide(Arc::new(Commands::default())).is_err(),
            "同类型服务唯一"
        );
        ctx.provide::<dyn Storage>(Arc::new(MemStorage::default()))
            .unwrap();
        let storage = ctx.get::<dyn Storage>().unwrap();
        storage.put("k", "v");
        assert_eq!(storage.read("k"), Some("v".into()));
    }

    /// 响应式激活：依赖缺席 → 等待（不崩溃）；能力出现 → 自动激活。
    #[test]
    fn reactive_activation_waits_then_activates() {
        let writes: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
        let mut loader = Loader::new();
        let marker = writes.clone();
        let fiber_id = loader
            .mount(fiber("cache").requires::<dyn Storage>(), move |scope| {
                let storage = scope.capability::<dyn Storage>()?;
                storage.put("boot", "1");
                marker.lock().unwrap().push("activated");
                Ok(())
            })
            .unwrap();
        assert_eq!(
            loader.fiber_status(fiber_id),
            Some(FiberStatus::Waiting),
            "依赖缺席 = 等待，不崩溃"
        );
        assert!(writes.lock().unwrap().is_empty());
        loader
            .provide::<dyn Storage>(Arc::new(MemStorage::default()))
            .unwrap();
        assert_eq!(
            loader.fiber_status(fiber_id),
            Some(FiberStatus::Active),
            "能力出现 = 自动激活"
        );
        assert_eq!(*writes.lock().unwrap(), vec!["activated"]);
        assert_eq!(
            loader.context().get::<dyn Storage>().unwrap().read("boot"),
            Some("1".into())
        );
    }

    /// 级联回滚与重新激活：A 提供能力，B 消费；撤 A → B 回滚（副作用回收）→
    /// 能力恢复 → B 用全新实例重新激活。
    #[test]
    fn cascade_rollback_then_reactivation_with_fresh_instances() {
        let mut loader = Loader::new();
        let provider_id = loader
            .mount(fiber("storage-a"), |scope| {
                scope.on_dispose("storage", || {});
                scope.provide::<dyn Storage>(Arc::new(MemStorage::default()))
            })
            .unwrap();
        let disposals: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
        let disposals_for_apply = disposals.clone();
        let consumer_id = loader
            .mount(fiber("consumer").requires::<dyn Storage>(), move |scope| {
                let storage = scope.capability::<dyn Storage>()?;
                storage.put("who", "consumer");
                let disposals = disposals_for_apply.clone();
                scope.on_dispose("consumer-cleanup", move || {
                    *disposals.lock().unwrap() += 1;
                });
                Ok(())
            })
            .unwrap();
        assert_eq!(loader.fiber_status(consumer_id), Some(FiberStatus::Active));
        assert_eq!(*disposals.lock().unwrap(), 0);

        // 撤 A → B 级联回滚，副作用回收。B 的激活闭包已消费（mount 成功即 FnOnce 用尽），
        // 级联回滚的诚实语义 = Retired 终态；重新激活 = 宿主再次 mount（全新实例）。
        loader.retire(provider_id);
        assert_eq!(loader.fiber_status(provider_id), Some(FiberStatus::Retired));
        assert_eq!(loader.fiber_status(consumer_id), Some(FiberStatus::Retired));
        assert_eq!(*disposals.lock().unwrap(), 1, "回滚时副作用被回收");

        // 能力恢复 → 宿主重新 mount（全新实例，副作用全新登记）。
        loader
            .provide::<dyn Storage>(Arc::new(MemStorage::default()))
            .unwrap();
        let disposals_for_remount = disposals.clone();
        loader
            .mount(
                fiber("consumer-2").requires::<dyn Storage>(),
                move |scope| {
                    let storage = scope.capability::<dyn Storage>()?;
                    storage.put("who", "consumer");
                    let disposals = disposals_for_remount.clone();
                    scope.on_dispose("consumer-cleanup", move || {
                        *disposals.lock().unwrap() += 1;
                    });
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(
            *disposals.lock().unwrap(),
            1,
            "重新激活不触发旧实例的 Disposer"
        );
        assert_eq!(
            loader.context().get::<dyn Storage>().unwrap().read("who"),
            Some("consumer".into()),
            "全新实例重新执行"
        );
    }

    /// 宿主移除能力（替换 Provider）同样触发级联回滚。
    #[test]
    fn host_capability_removal_cascades() {
        let mut loader = Loader::new();
        loader
            .provide::<dyn Storage>(Arc::new(MemStorage::default()))
            .unwrap();
        let consumer = loader
            .mount(fiber("c").requires::<dyn Storage>(), |scope| {
                scope.capability::<dyn Storage>()?;
                Ok(())
            })
            .unwrap();
        assert_eq!(loader.fiber_status(consumer), Some(FiberStatus::Active));
        assert!(loader.remove::<dyn Storage>());
        // 闭包已消费：级联回滚 = Retired 终态（诚实缺席），重新激活 = 再次 mount。
        assert_eq!(loader.fiber_status(consumer), Some(FiberStatus::Retired));
        loader
            .provide::<dyn Storage>(Arc::new(MemStorage::default()))
            .unwrap();
        let remounted = loader
            .mount(fiber("c2").requires::<dyn Storage>(), |scope| {
                scope.capability::<dyn Storage>()?;
                Ok(())
            })
            .unwrap();
        assert_eq!(loader.fiber_status(remounted), Some(FiberStatus::Active));
    }

    /// apply 失败：完整回滚（副作用回收 + 提供的服务移除）+ 显式错误。
    #[test]
    fn apply_failure_rolls_back_everything() {
        let mut loader = Loader::new();
        let disposed: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
        let disposed_for_apply = disposed.clone();
        let error = loader
            .mount(fiber("broken"), move |scope| {
                scope.provide::<dyn Storage>(Arc::new(MemStorage::default()))?;
                let disposed = disposed_for_apply.clone();
                scope.on_dispose("broken-cleanup", move || *disposed.lock().unwrap() = true);
                Err("boom".into())
            })
            .unwrap_err();
        assert!(error.contains("broken") && error.contains("boom"));
        assert!(*disposed.lock().unwrap(), "失败路径也回收副作用");
        assert!(
            !loader.context().contains::<dyn Storage>(),
            "失败路径移除其提供的服务"
        );
        assert!(loader.context().contains::<Commands>(), "内建服务不受影响");
    }

    /// Typed Event Bus（Live）：订阅经 Fiber 可逆——回滚即退订。
    #[test]
    fn event_bus_subscription_is_reversible() {
        struct Ping {
            seq: u32,
        }
        let mut loader = Loader::new();
        let seen: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_for_apply = seen.clone();
        let fiber_id = loader
            .mount(fiber("listener"), move |scope| {
                let seen = seen_for_apply.clone();
                scope
                    .subscribe::<Ping>(Arc::new(move |event| seen.lock().unwrap().push(event.seq)));
                Ok(())
            })
            .unwrap();
        loader
            .context()
            .get::<EventBus>()
            .unwrap()
            .publish(&Ping { seq: 1 });
        assert_eq!(*seen.lock().unwrap(), vec![1]);
        loader.retire(fiber_id);
        loader
            .context()
            .get::<EventBus>()
            .unwrap()
            .publish(&Ping { seq: 2 });
        assert_eq!(*seen.lock().unwrap(), vec![1], "回滚后订阅被回收");
    }

    /// 内建服务经 Scope 便捷注册（命令 + 槽位 + 候选来源），DSH ctx.tools 形态。
    #[test]
    fn builtin_services_via_scope() {
        struct Hello;
        impl CommandHandler for Hello {
            fn invoke(&self, payload: &Value) -> Result<Value, String> {
                Ok(json!({ "hi": payload.get("who").and_then(|v| v.as_str()).unwrap_or("world") }))
            }
        }
        let mut loader = Loader::new();
        loader
            .mount(fiber("ui-tools"), |scope| {
                scope.commands().register("ui.hello", Arc::new(Hello))?;
                scope.slots().register_view(
                    "ui-tools",
                    ViewContribution {
                        slot: SlotId("message.toolbar".into()),
                        component: "button".into(),
                        label: "Say hi".into(),
                        action: Some(CommandId("ui.hello".into())),
                        props: json!({}),
                        order: 10,
                        plugin: String::new(),
                    },
                );
                scope.completion_sources().register(CompletionSource {
                    name: "demo".into(),
                    triggers: vec![TriggerKind::Slash],
                    fetch: Arc::new(|query| {
                        vec![CandidateDto {
                            label: query.into(),
                            insert_text: query.into(),
                        }]
                    }),
                });
                Ok(())
            })
            .unwrap();
        let commands = loader.context().get::<Commands>().unwrap();
        assert_eq!(
            commands
                .handler("ui.hello")
                .unwrap()
                .invoke(&json!({"who": "composer"}))
                .unwrap(),
            json!({"hi": "composer"})
        );
        assert_eq!(
            loader
                .context()
                .get::<Slots>()
                .unwrap()
                .slot_views("message.toolbar")
                .len(),
            1
        );
        assert_eq!(
            loader
                .context()
                .get::<CompletionSources>()
                .unwrap()
                .for_trigger(TriggerKind::Slash)
                .len(),
            1
        );
    }
}
