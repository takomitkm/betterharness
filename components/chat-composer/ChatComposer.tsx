import type { ComponentType } from "react";
import type { ComposerEngine } from "./core.ts";
import { copy, hasContent, isEmptyDraft } from "./snapshots.ts";
import { useComposerSubmission } from "./useComposerSubmission.ts";

export interface EditorProps { engine: ComposerEngine; placeholder?: string }

export function TextareaEditor({ engine, placeholder }: EditorProps) {
  const view = useComposerSubmission(engine);
  return <textarea
    data-testid="editor" aria-label="消息" rows={4} placeholder={placeholder}
    value={view.state.draft.snapshot.text} readOnly={view.admitting || view.closed}
    onChange={(event) => {
      const current = engine.getSnapshot().state.draft.snapshot;
      void engine.edit({ ...copy(current), text: event.target.value, document: undefined, references: current.references.filter((reference) => reference.kind !== "mention") });
    }}
    onKeyDown={(event) => {
      engine.handleKey(event);
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
export function ChatComposer({ engine, Editor = TextareaEditor, placeholder = "写下一条消息…" }: {
  engine: ComposerEngine; Editor?: ComponentType<EditorProps>; placeholder?: string;
}) {
  const view = useComposerSubmission(engine);
  const snapshot = view.state.draft.snapshot;
  return <section className="chat-composer" aria-label="聊天输入框">
    <Editor engine={engine} placeholder={placeholder} />
    <div className="attachments" aria-label="草稿附件">
      {snapshot.attachments.map((file) => <span key={file.id}>
        {file.name} ({file.data.size} B)
        <button type="button" disabled={view.admitting} aria-label={`移除 ${file.name}`} onClick={() => {
          const latest = engine.getSnapshot().state.draft.snapshot;
          void engine.edit({ ...copy(latest), attachments: latest.attachments.filter((item) => item.id !== file.id) });
        }}>×</button>
      </span>)}
    </div>
    <div className="composer-actions">
      <label>添加附件 <input data-testid="files" type="file" multiple disabled={view.admitting} onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        const current = engine.getSnapshot().state.draft.snapshot;
        void engine.edit({ ...copy(current), attachments: [...current.attachments, ...files.map((file) => ({
          id: crypto.randomUUID(), name: file.name, mediaType: file.type || "application/octet-stream", data: file,
        }))] });
        event.target.value = "";
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
