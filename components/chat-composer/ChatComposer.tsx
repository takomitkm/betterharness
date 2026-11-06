import { useComposerSubmission } from "./useComposerSubmission.js";

/**
 * ChatComposer —— 极简聊天输入框。
 *
 * 语义（全部来自 useComposerSubmission，此处只做展示层）：
 * - Enter        发送；提交在途时按 Enter 是 no-op（不发送、不换行）
 * - Shift+Enter  换行
 * - IME 组合中   回车只确认候选，不发送
 * - 发送失败     正文恢复到空编辑器；用户已写新内容则保留新草稿 + 失败项提示
 *
 * 生产环境如果要 mention / 斜杠命令 / 富文本，可把 textarea 换成 Lexical
 * （ZCode 就是这么做的），但键盘语义与提交状态机不需要变。
 */

export interface ChatComposerProps {
  onSubmit?: (text: string) => Promise<void>;
  placeholder?: string;
  /** 模型生成中按 Enter 的投递方式；默认 queue（ZCode 语义），可选 steer / none */
  busyEnter?: "queue" | "steer" | "none";
  /** 设置后草稿防抖落盘（localStorage），挂载时恢复；受理同步清空草稿 */
  draftKey?: string;
  /** 状态条与失败项的中文文案开关；默认中文 */
  labels?: Partial<typeof DEFAULT_LABELS>;
}

const DEFAULT_LABELS = {
  hintIdle: "Enter 发送 · Shift+Enter 换行",
  hintBusy: "发送中…",
  failedTitle: "发送失败",
  retry: "重试",
  dismiss: "放弃",
};

export function ChatComposer({
  onSubmit = async () => {},
  placeholder = "",
  busyEnter = "queue",
  draftKey,
  labels,
}: ChatComposerProps) {
  const L = { ...DEFAULT_LABELS, ...labels };
  const c = useComposerSubmission({ onSubmit, busyEnter, draftKey });

  return (
    <div className="chat-composer">
      {c.failed.length > 0 ? (
        <ul className="chat-composer__failed" role="alert">
          {c.failed.map((f) => (
            <li key={f.id}>
              <span>
                {L.failedTitle}：{f.text}
              </span>
              <button type="button" onClick={() => c.retry(f.id)}>
                {L.retry}
              </button>
              <button type="button" onClick={() => c.dismissFailure(f.id)}>
                {L.dismiss}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <textarea
        value={c.text}
        onChange={(e) => c.setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") c.handleEnter(e);
          // ↑：编辑器为空且队列非空时，取回最近排队的一条
          if (e.key === "ArrowUp" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            const back = c.popQueueToEditor();
            if (back !== null) e.preventDefault();
          }
        }}
        placeholder={placeholder}
        rows={3}
        spellCheck={false}
      />

      <div className="chat-composer__bar">
        <span className="chat-composer__hint">
          {c.inFlight
            ? L.hintBusy
            : c.isGenerating
              ? "生成中…（Enter 排队 / ↑ 取回队列）"
              : L.hintIdle}
        </span>
        <button
          type="button"
          onClick={() => c.submit()}
          disabled={c.inFlight || !c.text.trim()}
        >
          发送
        </button>
      </div>
    </div>
  );
}