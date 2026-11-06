import { useCallback, useRef, useState } from "react";

/**
 * useComposerSubmission —— 聊天输入框的提交状态机。
 *
 * 从 ZCode 桌面端 v3.17.2 的「快速双击回车 → 消息已发出但输入框残留原文+换行」
 * bug 修复中提取（详见 README 的背景与 zai-org/feedback#1415）。
 *
 * 与真实实现的对应关系（语义等价，载体不同）：
 * - 真实实现用 Lexical 编辑器 + 草稿事务（capture/claim/restore）；
 *   这里用受控 textarea + 冻结快照字符串，规则完全一致。
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

export interface ComposerSubmission {
  /** 编辑器当前内容（受控值） */
  text: string;
  setText: (v: string) => void;
  /** 提交在途（受理后、结算前）。此窗口内 Enter 必须被消费，绝不能落成换行。 */
  inFlight: boolean;
  /** 已成功发送的条数 */
  sentCount: number;
  /** 发送失败的条目（正文保留，等待重试或放弃） */
  failed: ComposerFailure[];
  /**
   * 统一的 Enter 语义。Shift+Enter / IME 组合不经过这里（见函数体注释）。
   * 用法：<textarea onKeyDown={(e) => { if (e.key === "Enter") c.handleEnter(e); }} />
   */
  handleEnter: (e: ComposerKeyEvent) => void;
  /** 等价于按一次 Enter（发送按钮也走这里） */
  submit: () => void;
  /** 重试失败项：编辑器为空时先恢复原文（可编辑再发），否则直接重发 */
  retry: (id: string) => void;
  dismissFailure: (id: string) => void;
}

export function useComposerSubmission(
  onSubmit: (text: string) => Promise<void>,
): ComposerSubmission {
  const [text, setTextState] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const [failed, setFailed] = useState<ComposerFailure[]>([]);
  const [sentCount, setSentCount] = useState(0);

  // 规则①：同步 ref。事件处理器里直接读 state 会拿到旧值——快速双击的第二下
  // 读到的 inFlight 还是 false，这就是 ZCode 3.17.2 防不住双击的原因之一。
  // 「是否在途」「编辑器当前内容」一律走 ref。
  const inFlightRef = useRef(false);
  const textRef = useRef("");
  const seqRef = useRef(0);

  const setText = useCallback((v: string) => {
    textRef.current = v;
    setTextState(v);
  }, []);

  const submit = useCallback(() => {
    if (inFlightRef.current) return;
    const snapshot = textRef.current;
    if (!snapshot.trim()) return;

    const id = `msg-${++seqRef.current}`;

    // 规则②：受理即冻结 + 立即清空，且必须在同一同步块、第一个 await 之前。
    // ZCode 3.17.2 的 bug 就是这里没清空（等发送结算才清），于是「在途 + 正文还在」
    // 的窗口里第二次 Enter 被放行成换行，换行又让结算的清空门禁失效 → 残留。
    inFlightRef.current = true;
    setInFlight(true);
    setText("");

    void (async () => {
      try {
        await onSubmit(snapshot);
        setSentCount((n) => n + 1);
      } catch {
        // 规则③：失败恢复。只有编辑器仍是空（用户没开始写新内容）才搬回快照；
        // 用户已经开始写就绝不覆盖——失败项单独保留，交给用户重试或放弃。
        if (textRef.current.trim() === "") {
          setText(snapshot);
        }
        setFailed((f) => [...f, { id, text: snapshot }]);
      } finally {
        inFlightRef.current = false;
        setInFlight(false);
      }
    })();
  }, [onSubmit, setText]);

  const handleEnter = useCallback(
    (e: ComposerKeyEvent) => {
      // IME 组合中 / 候选确认键：不拦，交给输入法（中文输入回车确认候选时不能触发发送）
      if (e.isComposing) return;
      // Shift+Enter：显式换行，放行给编辑器默认行为
      if (e.shiftKey) return;
      e.preventDefault();
      // 规则④：在途一律 no-op——不发送、不换行、不动用户新写的草稿。
      // Ctrl/⌘+Enter 同样走这里（如需「反向投递」可在此扩展）。
      if (inFlightRef.current) return;
      // 空输入不提交
      if (!textRef.current.trim()) return;
      submit();
    },
    [submit],
  );

  const retry = useCallback(
    (id: string) => {
      setFailed((f) => {
        const item = f.find((x) => x.id === id);
        if (!item) return f;
        if (textRef.current.trim() === "") {
          // 编辑器为空：恢复原文，让用户看一眼/改一下再发
          setText(item.text);
        } else {
          // 用户正在写：直接原样重发，不动编辑器
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
    sentCount,
    failed,
    handleEnter,
    submit,
    retry,
    dismissFailure,
  };
}