import { useCallback, useRef, type ComponentType } from "react";
import type { ComposerEngine } from "./core.ts";
import { copy, documentWithoutAttachment, hasContent, isEmptyDraft, newAssetId } from "./snapshots.ts";
import { ImeTracker, decideEnter } from "./key-decision.ts";
import { useComposerSubmission } from "./useComposerSubmission.ts";
import type { Candidate, TriggerKind } from "./completion.ts";
import type { AssetId } from "./types.ts";

/** 候选来源（宿主提供）：reference 对应 @，slash 对应 /；返回候选数组或其 Promise。 */
export type CompletionProvider = (kind: TriggerKind, query: string) => Candidate[] | Promise<Candidate[]>;

export interface EditorProps {
  engine: ComposerEngine;
  placeholder?: string;
  /**
   * 富文本编辑器（Lexical）挂载后注册「在当前光标处插入附件节点」的入口，卸载时以 null 注销。
   * 纯文本编辑器不注册：其文档只是纯文本，附件保持 rail-only，不进有序文档（见 ChatComposer）。
   */
  registerAttachmentInserter?: (insert: ((assetId: AssetId) => void) | null) => void;
  /**
   * 候选菜单来源。缺省时富文本侧也不开菜单。旧查询的迟到结果由组件内的代次守卫拒绝；
   * 纯文本编辑器不使用（菜单暂缓，与 rail-only 附件同款的不对称，见 README）。
   */
  completionProvider?: CompletionProvider;
}

export function TextareaEditor({ engine, placeholder }: EditorProps) {
  const view = useComposerSubmission(engine);
  // Enter/IME 仲裁与 LexicalEditor 同源：组合事件喂给 tracker，Enter 裁决统一交给 key-decision。
  const imeRef = useRef<ImeTracker | null>(null);
  if (!imeRef.current) imeRef.current = new ImeTracker();
  return <textarea
    data-testid="editor" aria-label="消息" rows={4} placeholder={placeholder}
    value={view.state.draft.snapshot.text} readOnly={view.admitting || view.closed}
    onCompositionStart={() => imeRef.current!.onCompositionStart()}
    onCompositionEnd={() => imeRef.current!.onCompositionEnd(Date.now())}
    onChange={(event) => {
      const current = engine.getSnapshot().state.draft.snapshot;
      void engine.edit({ ...copy(current), text: event.target.value, document: undefined, references: current.references.filter((reference) => reference.kind !== "mention") });
    }}
    onKeyDown={(event) => {
      const current = engine.getSnapshot();
      const nowMs = Date.now();
      const ime = imeRef.current!.isComposing(nowMs);
      const verdict = decideEnter({
        key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
        isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode, repeat: event.repeat ?? false,
        composing: ime.composing, composingUntilMs: ime.composingUntilMs, nowMs,
        // 纯文本编辑器不接候选菜单（与 rail-only 附件同款的不对称，见 README 范围说明）：
        // completion 状态机只接富文本侧，这里 hasMenu 恒为 false。
        hasMenu: false,
        canSubmit: !current.admitting && !current.closed && !current.sending && hasContent(current.state.draft.snapshot),
      });
      // hand-to-ime / newline：不拦截浏览器（输入法确认 / textarea 默认换行）；其余按裁决拦截。
      if (verdict.preventDefault) event.preventDefault();
      if (verdict.kind === "submit") engine.handleKey(event); // 既有提交路径：引擎自有守卫不变。
      if (event.key === "ArrowUp" && !event.shiftKey && !event.ctrlKey && !event.metaKey && isEmptyDraft(engine.getSnapshot().state.draft.snapshot)) {
        event.preventDefault(); void engine.takeLatestQueued();
      }
    }}
  />;
}

const statusLabels = {
  queued: "已保存，等待投递", sending: "正在提交", accepted: "已接纳",
  rejected: "明确未发送", unknown: "送达待确认，未自动重发", cancelled: "已取回编辑",
};

/** The host provides a durable engine and optionally a rich editor. There is no implicit-success transport. */
export function ChatComposer({ engine, Editor = TextareaEditor, placeholder = "写下一条消息…", completionProvider }: {
  engine: ComposerEngine; Editor?: ComponentType<EditorProps>; placeholder?: string; completionProvider?: CompletionProvider;
}) {
  const view = useComposerSubmission(engine);
  const snapshot = view.state.draft.snapshot;
  const inserterRef = useRef<((assetId: AssetId) => void) | null>(null);
  const registerAttachmentInserter = useCallback((insert: ((assetId: AssetId) => void) | null) => {
    inserterRef.current = insert;
  }, []);
  return <section className="chat-composer" aria-label="聊天输入框">
    <Editor engine={engine} placeholder={placeholder} registerAttachmentInserter={registerAttachmentInserter} completionProvider={completionProvider} />
    <div className="attachments" aria-label="草稿附件">
      {snapshot.attachments.map((file) => <span key={file.id}>
        {file.name} ({file.data.size} B)
        <button type="button" disabled={view.admitting} aria-label={`移除 ${file.name}`} onClick={() => {
          const latest = engine.getSnapshot().state.draft.snapshot;
          // 一次变更同时撤下附件条目与其在有序文档中的节点：文档附件节点的 AssetId 不允许悬空，
          // 所以不能先删条目再等编辑器同步（validateSnapshot 会拒绝中间状态）。
          void engine.edit({
            ...copy(latest),
            attachments: latest.attachments.filter((item) => item.id !== file.id),
            document: latest.document
              ? { ...latest.document, value: documentWithoutAttachment(latest.document.value, file.id) }
              : undefined,
          });
        }}>×</button>
      </span>)}
    </div>
    <div className="composer-actions">
      <label>添加附件 <input data-testid="files" type="file" multiple disabled={view.admitting} onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (!files.length) return;
        const current = engine.getSnapshot().state.draft.snapshot;
        const entries = files.map((file) => ({
          id: newAssetId(), name: file.name, mediaType: file.type || "application/octet-stream", data: file,
        }));
        // 附件条目先进快照；等它落盘后再把节点插到光标处（onChange 携带同一批 AssetId
        // 更新有序文档）。不能并发：条目编辑的中间渲染会用旧文档重置编辑器，吞掉刚插入的节点。
        // 不对称说明：纯文本模式没有插入入口（registerAttachmentInserter 未注册），
        // 附件保持 rail-only，文档仍是纯文本。
        void (async () => {
          if (!(await engine.edit({ ...copy(current), attachments: [...current.attachments, ...entries] }))) return;
          const insert = inserterRef.current;
          if (insert) for (const entry of entries) insert(entry.id);
        })();
      }} /></label>
      <button type="button" data-testid="send" disabled={view.admitting || view.sending || !hasContent(snapshot) || view.closed} onClick={() => void engine.submit()}>发送</button>
      <button type="button" data-testid="take-queue" disabled={view.admitting || !isEmptyDraft(snapshot) || !view.state.submissions.some((item) => item.status === "queued")} onClick={() => void engine.takeLatestQueued()}>取回最近排队消息</button>
    </div>
    <p role="status" data-testid="status">
      {view.admitting ? "正在可靠保存消息…" : view.sending ? "等待对端接纳，可继续写新草稿" : view.state.activeTurn ? "本轮运行中，按当前投递设置处理新消息" : "Enter 发送 · Shift+Enter 换行"}
      {view.dirty ? " · 当前输入尚未保存" : ""}
    </p>
    {Boolean(view.error || view.pendingReceipts) && <p role="alert" data-testid="storage-error">
      {view.error ?? "回执尚未可靠保存"}。消息和当前输入仍保留。
      <button type="button" onClick={() => void engine.flush()}>重试本地保存</button>
    </p>}
    {view.paused && <p role="alert">已暂停自动投递。请先确认待确认消息和当前轮次。<button type="button" data-testid="resume" onClick={() => engine.resume()}>继续投递已保存的队列</button></p>}
    <ol aria-label="提交记录" data-testid="outbox">
      {view.state.submissions.map((record) => <li key={record.id} data-status={record.status} data-message-id={record.id}>
        <strong>{statusLabels[record.status]}</strong>
        <p className="message-text">{record.snapshot.text || "（仅附件或引用）"}</p>
        {record.snapshot.attachments.map((file) => <span key={file.id}>{file.name} ({file.data.size} B) </span>)}
        {record.reason && <small>{record.reason}</small>}
        {record.status === "unknown" && <button type="button" onClick={() => void engine.query(record.id)}>核对送达状态</button>}
        {record.status === "rejected" && <>
          <button type="button" onClick={() => void engine.retry(record.id)}>原样重试</button>
          <button type="button" disabled={!isEmptyDraft(snapshot) || view.admitting} onClick={() => void engine.restore(record.id)}>取回编辑</button>
        </>}
        {["accepted", "rejected", "cancelled"].includes(record.status) && <button type="button" onClick={() => {
          if (window.confirm("移除此条本地记录及其附件副本？这不会撤回已经送达的消息。")) void engine.remove(record.id);
        }}>移除本地记录</button>}
      </li>)}
    </ol>
  </section>;
}
