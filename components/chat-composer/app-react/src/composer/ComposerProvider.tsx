// ComposerProvider：Bridge 订阅的 React 绑定（PRODUCT-LINE-PLAN §5.2 原子订阅语义）。
//
// 原子订阅契约：subscribe(listener) **同步地**（1）注册 listener、（2）向 listener 推送
// 基准快照（当前 revision）——之后才可能有新快照。listener 收到的快照 revision 单调；
// 过期快照（revision 更小）被丢弃（useSyncExternalStore 的 getSnapshot 返回缓存）。
//
// 桥面是 JSON 字符串（D003）：Client 负责解析 + 守卫（isDispatchResult）+ 过期丢弃，
// React 侧只见 SnapshotDto 对象缓存。
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import {
  isDispatchResult,
  type ComposerEventDto,
  type DispatchResultDto,
  type EffectOutcomeDto,
  type SnapshotDto,
} from '../generated/protocol.ts';

/** Bridge 客户端最小面（框架无关；Web=WasmBridge，Desktop=Tauri IPC，测试=内存替身）。 */
export interface ComposerBridgeClient {
  /** 当前快照缓存（同步可得，供 getSnapshot）。 */
  current(): SnapshotDto;
  /** 原子订阅：注册 listener 并立即推送基准快照；返回退订。 */
  subscribe(listener: (snapshot: SnapshotDto) => void): () => void;
  /** 派发 UI 事件（JSON 字符串面，实现内部解析）。 */
  dispatch(event: ComposerEventDto): Promise<void>;
  /** Effect 回执；引用不存在/形状不匹配以异常抛出（AckError 判词）。 */
  ack(refId: number, outcome: EffectOutcomeDto): Promise<void>;
  dispose(): Promise<void>;
}

/** 由 DispatchResult 推进 Effect 执行的宿主回调：Persist/Deliver/Timeout 由宿主桥执行。 */
export type EffectExecutor = (result: DispatchResultDto, previous: DispatchResultDto | null) => void | Promise<void>;

interface ProviderValue {
  client: ComposerBridgeClient;
  /** 当前快照（revision 单调缓存）。 */
  snapshot: SnapshotDto;
  /** 派发事件（Provider 负责把 DispatchResult 交给 executor）。 */
  dispatch: (event: ComposerEventDto) => Promise<void>;
}

const ComposerContext = createContext<ProviderValue | null>(null);

/**
 * 原子订阅 hook：内部用 useSyncExternalStore（React 18 并发安全）。
 * listener 推进 = client.current() 已更新缓存 → notify 变化。
 */
export function useComposerSnapshot(): SnapshotDto {
  const value = useContext(ComposerContext);
  if (!value) throw new Error('ComposerProvider 缺失');
  return useSyncExternalStore(
    (onStoreChange) => value.client.subscribe(() => onStoreChange()),
    () => value.snapshot,
    () => value.snapshot,
  );
}

export function useComposerDispatcher(): (event: ComposerEventDto) => Promise<void> {
  const value = useContext(ComposerContext);
  if (!value) throw new Error('ComposerProvider 缺失');
  return value.dispatch;
}

/**
 * Provider：挂载 client，维护 revision 单调的快照缓存，把每个 DispatchResult 交给
 * executor（宿主桥：Persist→IndexedDB/文件 + Deliver→传输 + 超时排程，再把结果 ack 回来）。
 * 卸载只退订不销毁 Runtime（dispose 归宿主生命周期，PRODUCT-LINE-PLAN §5.6）。
 */
export function ComposerProvider({ client, executor, children }: {
  client: ComposerBridgeClient;
  /** 宿主 Effect 执行器：看到 Persist/Deliver/ScheduleTimeout 引用并 ack 回结果。 */
  executor: EffectExecutor;
  children: ReactNode;
}) {
  const cache = useMemo(() => ({ snapshot: client.current(), previous: null as DispatchResultDto | null }), [client]);
  const value = useMemo<ProviderValue>(() => ({
    client,
    snapshot: cache.snapshot,
    dispatch: async (event) => {
      const result = await client.dispatch(event);
      if (result.snapshot.revision >= cache.snapshot.revision) {
        cache.previous = { snapshot: cache.snapshot, effects: [] } as unknown as DispatchResultDto;
        cache.snapshot = result.snapshot;
      }
      await executor(result, cache.previous);
      // executor 的 ack 会再触发 client 快照更新（经 subscribe 通知），缓存随订阅刷新。
    },
  }), [client, executor, cache]);
  // 订阅在渲染外执行一次：Provider 挂载即建立原子订阅，快照缓存随通知刷新。
  useMemo(() => client.subscribe((snapshot) => {
    if (snapshot.revision >= cache.snapshot.revision) cache.snapshot = snapshot;
  }), [client, cache]);
  return <ComposerContext.Provider value={value}>{children}</ComposerContext.Provider>;
}

/** 内存测试替身（PRODUCT-LINE-PLAN §4.4：Mock 仅测试，不当最终实现）。 */
export class MemoryBridgeClient implements ComposerBridgeClient {
  private listeners = new Set<(snapshot: SnapshotDto) => void>();
  private cache: SnapshotDto;
  private emitter: (event: ComposerEventDto) => Promise<DispatchResultDto>;

  constructor(initial: SnapshotDto, emitter: (event: ComposerEventDto) => Promise<DispatchResultDto>) {
    this.cache = initial;
    this.emitter = emitter;
  }

  current(): SnapshotDto {
    return this.cache;
  }

  subscribe(listener: (snapshot: SnapshotDto) => void): () => void {
    this.listeners.add(listener);
    listener(this.cache); // 原子订阅：注册即推基准快照。
    return () => this.listeners.delete(listener);
  }

  private publish(snapshot: SnapshotDto): void {
    if (snapshot.revision < this.cache.revision) return; // 过期丢弃。
    this.cache = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  async dispatch(event: ComposerEventDto): Promise<void> {
    const result = await this.emitter(event);
    if (!isDispatchResult(result)) throw new Error('bad dispatch result');
    this.publish(result.snapshot);
  }

  async ack(_refId: number, _outcome: EffectOutcomeDto): Promise<void> {
    // 测试替身：executor 直接调 emitter，ack 路径由真实 Host 覆盖。
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
  }
}
