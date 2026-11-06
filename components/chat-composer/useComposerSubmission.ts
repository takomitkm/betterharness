import { useCallback, useRef, useState } from "react";

/**
 * useComposerSubmission —— 聊天输入框的提交状态机（含 turn 生命周期与草稿持久化）。
 *
 * 从 ZCode 桌面端 v3.17.2 的「快速双击回车 → 消息已发出但输入框残留原文+换行」
 * bug 修复中提取（zai-org/feedback#1415；背景与规则详见同目录 README.md）。
 *
 * 语义载体说明：真实实现用 Lexical 编辑器 + 草稿事务（capture/claim/restore）+
 * CLI 驱动的 turn 生命周期；这里用受控 textarea + 冻结快照字符串 + 宿主手动驱动
 * beginTurn/endTurn，规则完全一致。
 */

export interface ComposerFailure {
  id: string;
  text: string;
}

/** 结构兼容 React.KeyboardEvent<HTMLTextAreaElement> */
export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  preventDefault: () => void;
}

/** 模型生成中按 Enter 的投递方式。默认 "queue"，对齐 ZCode 的 inputRouting。 */
export type BusyEnterMode = "queue" | "steer" | "none";

/** 草稿落盘接口；默认实现包一层 localStorage（不存在时静默降级为无持久化）。 */
export interface DraftStorage {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

const defaultStorage: DraftStorage = {
  get: (key) => (typeof localStorage !== "undefined" ? localStorage.getItem(key) : null),
  set: (key, value) => {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  },
};

export interface UseComposerSubmissionOptions {
  onSubmit: (text: string) => Promise<void>;
  /** 生成中按 Enter：queue=排队（默认，ZCode/Claude Code 语义）；steer=并入当前轮（Codex 语义）；none=保留草稿不投递 */
  busyEnter?: BusyEnterMode;
  /** 设置后草稿防抖落盘并在挂载时恢复。受理会同步清空草稿——防刷新复活已发正文（ZCode bug 的另一半）。 */
  draftKey?: string;
  /** 草稿防抖时长，默认 350 ms（对齐 ZCode） */
  draftDebounceMs?: number;
  /** 注入存储（默认 localStorage）；测试用 mock 实现 */
  storage?: DraftStorage;
}

export interface ComposerTurnApi {
  /** 模型是否在生成中。由宿主调 beginTurn()/endTurn() 驱动（真实产品里由 turn 事件驱动）。 */
  isGenerating: boolean;
  /** turn 开始（模型开始生成） */
  beginTurn: () => void;
  /** turn 结束。队列非空时自动发出下一条。 */
  endTurn: () => void;
  /** 当前排队中的消息（FIFO） */
  queue: string[];
  /** ↑ 键语义：编辑器为空时取回最近排队的一条；非空或队列为空返回 null */
  popQueueToEditor: () => string | null;
}

export interface ComposerSubmission extends ComposerTurnApi {
  /** 编辑器当前内容（受控值） */
  text: string;
  setText: (v: string) => void;
  /** 提交在途（受理后、结算前）。此窗口内 Enter 必须被消费，绝不能落成换行。 */
  inFlight: boolean;
  sentCount: number;
  failed: ComposerFailure[];
  /**
   * 统一的 Enter 语义（优先级从上到下）：
   * 1. IME 组合中 → 不拦（回车确认候选）
   * 2. Shift+Enter → 放行为换行
   * 3. 提交在途 → no-op（不发送、不换行、不动新草稿）
   * 4. 生成中 → 按 busyEnter 路由：queue（排队）/ steer（并入当前轮）/ none（保留草稿）
   * 5. 空输入 → 不提交
   * 6. 其余 → 提交（受理即清空）
   */
  handleEnter: (e: ComposerKeyEvent) => void;
  submit: () => void;
  retry: (id: string) => void;
  dismissFailure: (id: string) => void;
}

export function useComposerSubmission(
  options: UseComposerSubmissionOptions,
): ComposerSubmission {
  const {
    onSubmit,
    busyEnter = "queue",
    draftKey,
    draftDebounceMs = 350,
    storage = defaultStorage,
  } = options;

  // 挂载恢复：从 storage 读草稿（惰性，仅首次挂载执行一次）。
  // 规则⑥：恢复的内容必须 ref/state 成对初始化——只写 state 不写 ref，
  // submit 会读到空文本而早退（ref 说"空输入"，state 说"有草稿"）。
  // ZCode 真实实现的对应物：syncInitialValueOnMount → inputApi.setText(initialValue)。
  const restoredRef = useRef<string | null>(null);
  const [text, setTextState] = useState(() => {
    if (!draftKey) return "";
    const v = storage.get(draftKey) ?? "";
    restoredRef.current = v;
    return v;
  });
  const [inFlight, setInFlight] = useState(false);
  const [failed, setFailed] = useState<ComposerFailure[]>([]);
  const [sentCount, setSentCount] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [queue, setQueueState] = useState<string[]>([]);

  // 规则①：「是否在途」「正在生成」「编辑器内容」一律用同步 ref 读——
  // 事件处理器里读 state 是旧值，快速双击的第二下防重复提交会失效。
  const inFlightRef = useRef(false);
  const generatingRef = useRef(false);
  // 规则⑥：ref 初值 = 挂载恢复的草稿（与 state 成对）
  const textRef = useRef(text);
  const queueRef = useRef<string[]>([]);
  const seqRef = useRef(0);

  // 选项走 ref：回调不因设置变化而重挂
  const busyEnterRef = useRef(busyEnter);
  busyEnterRef.current = busyEnter;
  const storageRef = useRef(storage);
  storageRef.current = storage;

  const draftTimerRef = useRef<number | null>(null);

  const setText = useCallback(
    (v: string) => {
      textRef.current = v;
      setTextState(v);
      if (draftKey) {
        if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
        draftTimerRef.current = setTimeout(() => {
          draftTimerRef.current = null;
          storageRef.current.set(draftKey, textRef.current);
        }, draftDebounceMs);
      }
    },
    [draftKey, draftDebounceMs],
  );

  // 规则②的另一半：受理时同步占用/清空草稿，不等防抖。
  // 否则提交后 350ms 内刷新页面，会把已发出的正文当草稿恢复出来（ZCode bug 的后果之一）。
  const claimDraft = useCallback(() => {
    if (draftTimerRef.current !== null) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (draftKey) storageRef.current.set(draftKey, "");
  }, [draftKey]);

  function setQueueBoth(next: string[]) {
    queueRef.current = next;
    setQueueState(next);
  }

  const doSubmit = useCallback(
    (snapshot: string, id: string, onDone?: () => void) => {
      void (async () => {
        try {
          await onSubmit(snapshot);
          setSentCount((n) => n + 1);
        } catch {
          // 规则④：失败恢复。编辑器仍是空（用户没写新内容）才搬回快照；
          // 用户已经开始写就绝不覆盖——失败项单独保留，交给用户重试或放弃。
          if (textRef.current.trim() === "") {
            setText(snapshot);
          }
          setFailed((f) => [...f, { id, text: snapshot }]);
        } finally {
          inFlightRef.current = false;
          setInFlight(false);
          onDone?.();
        }
      })();
    },
    [onSubmit, setText],
  );

  const submit = useCallback(() => {
    if (inFlightRef.current) return;
    const snapshot = textRef.current;
    if (!snapshot.trim()) return;
    const id = `msg-${++seqRef.current}`;

    // 规则②：受理即冻结 + 立即清空 + 同步占用草稿，同一同步块、第一个 await 之前。
    inFlightRef.current = true;
    setInFlight(true);
    claimDraft();
    setText("");

    doSubmit(snapshot, id);
  }, [claimDraft, doSubmit, setText]);

  const beginTurn = useCallback(() => {
    generatingRef.current = true;
    setGenerating(true);
  }, []);

  const endTurn = useCallback(() => {
    generatingRef.current = false;
    setGenerating(false);
    // 本轮结束：队列非空则自动发出下一条（ZCode/Claude Code 语义）；发完继续 drain
    const drain = () => {
      if (generatingRef.current || inFlightRef.current) return;
      const next = queueRef.current[0];
      if (next === undefined) return;
      setQueueBoth(queueRef.current.slice(1));
      const id = `msg-${++seqRef.current}`;
      inFlightRef.current = true;
      setInFlight(true);
      doSubmit(next, id, () => setTimeout(drain, 0));
    };
    setTimeout(drain, 0);
  }, [doSubmit]);

  const popQueueToEditor = useCallback(() => {
    // ↑ 取回：编辑器非空时不覆盖用户输入；队列为空返回 null
    if (queueRef.current.length === 0 || textRef.current.trim() !== "") return null;
    const out = queueRef.current[queueRef.current.length - 1]!;
    setQueueBoth(queueRef.current.slice(0, -1));
    setText(out);
    return out;
  }, [setText]);

  const handleEnter = useCallback(
    (e: ComposerKeyEvent) => {
      // IME 组合中 / 候选确认：不拦
      if (e.isComposing) return;
      // Shift+Enter：显式换行，放行
      if (e.shiftKey) return;
      e.preventDefault();

      // 提交在途：一律 no-op——不发送、不换行、不动用户新写的草稿
      if (inFlightRef.current) return;

      // 生成中：按 busyEnter 路由（ZCode=queue / Codex=steer / 关闭=none）
      if (generatingRef.current) {
        const t = textRef.current;
        if (busyEnterRef.current === "none" || !t.trim()) return;
        if (busyEnterRef.current === "queue") {
          // 排队：只入队并清空编辑器，本轮结束（endTurn）时由 drain 自动发出。
          // 不占 inFlight——此时用户还能继续排更多条。
          setQueueBoth([...queueRef.current, t]);
          setText("");
          return;
        }
        // steer：并入当前轮——直接发送（本次在途窗口照常生效）
        const id = `msg-${++seqRef.current}`;
        inFlightRef.current = true;
        setInFlight(true);
        claimDraft();
        setText("");
        doSubmit(t, id);
        return;
      }

      if (!textRef.current.trim()) return;
      submit();
    },
    [claimDraft, doSubmit, setText, submit],
  );

  const enqueue = useCallback((t: string) => {
    setQueueBoth([...queueRef.current, t]);
  }, []);

  const retry = useCallback(
    (id: string) => {
      setFailed((f) => {
        const item = f.find((x) => x.id === id);
        if (!item) return f;
        if (textRef.current.trim() === "") {
          setText(item.text);
        } else {
          void (async () => {
            try {
              await onSubmit(item.text);
              setSentCount((n) => n + 1);
            } catch {
              setFailed((prev) => [...prev, item]);
            }
          })();
        }
        return f.filter((x) => x.id !== id);
      });
    },
    [onSubmit, setText],
  );

  const dismissFailure = useCallback((id: string) => {
    setFailed((f) => f.filter((x) => x.id !== id));
  }, []);

  return {
    text,
    setText,
    inFlight,
    isGenerating: generating,
    beginTurn,
    endTurn,
    queue,
    popQueueToEditor,
    sentCount,
    failed,
    handleEnter,
    submit,
    retry,
    dismissFailure,
  };
}