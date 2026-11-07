import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { ComposerEngine } from "./core.ts";
import { copy, documentAttachmentNodes, documentWithoutAttachment, hasContent, isEmptyDraft, newAssetId } from "./snapshots.ts";
import { ImeTracker, decideEnter } from "./key-decision.ts";
import { useComposerSubmission } from "./useComposerSubmission.ts";
import type { Candidate, TriggerKind } from "./completion.ts";
import { intakeFiles, type FileMeta, type IntakePolicy, type IntakeRejection, type IntakeRejectionReason } from "./intake.ts";
import { AttachmentCards, DropOverlay, intakeLimitsText } from "./AttachmentCards.tsx";
import type { AssetId } from "./types.ts";

/** 候选来源（宿主提供）：reference 对应 @，slash 对应 /；返回候选数组或其 Promise。 */
export type CompletionProvider = (kind: TriggerKind, query: string) => Candidate[] | Promise<Candidate[]>;

/** 一次粘贴/拖放事件里同步取出的单个文件；目录由浏览器侧 webkitGetAsEntry 识别后标注。 */
export interface IntakeFile {
  file: File;
  directory: boolean;
}

export interface EditorProps {
  engine: ComposerEngine;
  placeholder?: string;
  /**
   * 富文本编辑器（Lexical）挂载后注册「在当前光标处插入附件节点」的入口，卸载时以 null 注销。
   * 纯文本编辑器不注册：其文档只是纯文本，附件保持 rail-only，不进有序文档（见 ChatComposer）。
   */
  registerAttachmentInserter?: (insert: ((assetId: AssetId) => void) | null) => void;
  /**
   * 富文本编辑器挂载后注册「把附件节点移到附件序列第 targetAttachmentIndex 位」的入口
   * （目标下标语义见 reorder.ts），卸载时以 null 注销。移动只改文档顺序，引擎不参与；
   * 纯文本编辑器不注册：无有序文档即无移动（rail-only 不对称，见 README）。
   */
  registerAttachmentMover?: (move: ((assetId: AssetId, targetAttachmentIndex: number) => void) | null) => void;
  /**
   * 候选菜单来源。缺省时富文本侧也不开菜单。旧查询的迟到结果由组件内的代次守卫拒绝；
   * 纯文本编辑器不使用（菜单暂缓，与 rail-only 附件同款的不对称，见 README）。
   */
  completionProvider?: CompletionProvider;
  /**
   * 统一文件准入入口（文件选择器/粘贴/拖放三个入口共用 ChatComposer.runIntake）。
   * 粘贴处理器必须在事件内同步取出 File（await 之后剪贴板即失效）再调用；
   * after 在附件条目可靠落盘后回调（粘贴的纯文本部分用它排在文件之后插入）。
   */
  intake?: (batch: readonly IntakeFile[], after?: () => void) => void;
}

/** 准入拒绝原因的中文呈现（警告列表用）。 */
const INTAKE_REJECTION_LABELS: Record<IntakeRejectionReason, string> = {
  too_many: "文件数量超出上限",
  file_too_large: "超过单个文件大小上限",
  total_too_large: "超过附件总大小上限",
  unsupported_type: "不支持的文件类型",
};

/**
 * 拖放事件的同步提取：DataTransfer.files 与 file 类 items 按顺序配对（DSH 同款），
 * 目录用 webkitGetAsEntry 识别——目录掉落的 File 与空文件无法区分，条目 API 是唯一来源；
 * 不支持该 API 的浏览器按普通文件报告。必须在事件处理器内同步完成。
 */
function droppedBatch(dataTransfer: DataTransfer): IntakeFile[] {
  const batch: IntakeFile[] = [];
  let index = 0;
  for (const item of dataTransfer.items) {
    if (item.kind !== "file") continue;
    const file = dataTransfer.files[index++] ?? item.getAsFile();
    if (!file) continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    batch.push({ file, directory: entry?.isDirectory === true });
  }
  return batch;
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
export function ChatComposer({ engine, Editor = TextareaEditor, placeholder = "写下一条消息…", completionProvider, intakePolicy }: {
  engine: ComposerEngine; Editor?: ComponentType<EditorProps>; placeholder?: string; completionProvider?: CompletionProvider;
  /** 统一文件准入策略（选择器/粘贴/拖放共用）；缺省 = 不限制。 */
  intakePolicy?: IntakePolicy;
}) {
  const view = useComposerSubmission(engine);
  const snapshot = view.state.draft.snapshot;
  const inserterRef = useRef<((assetId: AssetId) => void) | null>(null);
  const registerAttachmentInserter = useCallback((insert: ((assetId: AssetId) => void) | null) => {
    inserterRef.current = insert;
  }, []);
  const moverRef = useRef<((assetId: AssetId, targetAttachmentIndex: number) => void) | null>(null);
  const registerAttachmentMover = useCallback((move: ((assetId: AssetId, targetAttachmentIndex: number) => void) | null) => {
    moverRef.current = move;
  }, []);
  // rail 卡片「前移/后移」的入口：目标下标由 AttachmentCards 按文档顺序换算，这里只转发。
  // 不变量：移动不经过引擎——只改有序文档里的节点顺序，outbox 与 attachments 列表
  // （rail 的顺序与 object-URL 生命周期）一概不动；新顺序经编辑器 onChange 正常回写草稿。
  const onMoveAttachment = useCallback((assetId: AssetId, targetAttachmentIndex: number) => {
    moverRef.current?.(assetId, targetAttachmentIndex);
  }, []);
  // 文档顺序里的附件 AssetId 序列（rail 移动按钮的换算依据）。纯文本模式没有有序文档
  // → undefined，rail 不给移动按钮（rail-only 不对称）。身份来自引擎已校验的草稿快照。
  const documentAttachmentOrder = useMemo<readonly AssetId[] | undefined>(() => {
    const document = snapshot.document;
    if (!document) return undefined;
    return documentAttachmentNodes(document.value).map((node) => node.assetId as AssetId);
  }, [snapshot.document]);
  const [intakeNotice, setIntakeNotice] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const canAcceptDrop = !view.admitting && !view.closed;

  const removeAttachment = useCallback((id: AssetId) => {
    const latest = engine.getSnapshot().state.draft.snapshot;
    // 一次变更同时撤下附件条目与其在有序文档中的节点：文档附件节点的 AssetId 不允许悬空，
    // 所以不能先删条目再等编辑器同步（validateSnapshot 会拒绝中间状态）。
    void engine.edit({
      ...copy(latest),
      attachments: latest.attachments.filter((item) => item.id !== id),
      document: latest.document
        ? { ...latest.document, value: documentWithoutAttachment(latest.document.value, id) }
        : undefined,
    });
  }, [engine]);

  /**
   * 统一准入路径：文件选择器、粘贴、拖放都汇到这里（DSH InputBar.intakeFiles 的共享准入）。
   * 目录条目已由浏览器侧识别，记录名称并按不支持类型拒绝；其余走 intakeFiles 纯检查。
   * 接受的条目先进快照；等它落盘后再执行 after（粘贴的纯文本）并把节点插到光标处
   * （onChange 携带同一批 AssetId 更新有序文档）。不能并发：条目编辑的中间渲染会用旧文档
   * 重置编辑器，吞掉刚插入的节点。不对称说明：纯文本模式没有插入入口
   * （registerAttachmentInserter 未注册），附件保持 rail-only，文档仍是纯文本。
   */
  const runIntake = useCallback((batch: readonly IntakeFile[], after?: () => void) => {
    const current = engine.getSnapshot();
    // 准入守卫（DSH 同款）：只读窗口（admitting）或已关闭的会话不接收文件。
    if (current.admitting || current.closed) return;
    const draftSnapshot = current.state.draft.snapshot;
    const pairs: { file: File; meta: FileMeta }[] = [];
    const directoryRejections: IntakeRejection[] = [];
    for (const item of batch) {
      if (item.directory) {
        directoryRejections.push({ name: item.file.name, reason: "unsupported_type" });
        continue;
      }
      pairs.push({
        file: item.file,
        meta: { name: item.file.name, mediaType: item.file.type || "application/octet-stream", bytes: item.file.size },
      });
    }
    const decision = intakeFiles(
      pairs.map((pair) => pair.meta),
      intakePolicy ?? {},
      draftSnapshot.attachments.map((entry) => ({ name: entry.name, mediaType: entry.mediaType, bytes: entry.data.size })),
    );
    const rejections = [...directoryRejections, ...decision.rejected];
    // 最近一次准入决定覆盖旧提示：列出名称与原因供用户处理；绝不阻塞已接受文件随消息发送。
    setIntakeNotice(rejections.length
      ? rejections.map((item) => `${item.name}（${INTAKE_REJECTION_LABELS[item.reason]}）`).join("；")
      : null);
    if (!decision.accepted.length) {
      // DSH：文件准入被拒时，同一次粘贴里的纯文本仍然插入（intake 为空操作，文本路由继续）。
      after?.();
      return;
    }
    // accepted 里的对象就是传入的 FileMeta 本体（intake.ts 承诺不复制），据此找回原始 File。
    const entries = decision.accepted.map((fileMeta) => {
      const pair = pairs.find((candidate) => candidate.meta === fileMeta)!;
      return { id: newAssetId(), name: pair.meta.name, mediaType: pair.meta.mediaType, data: pair.file };
    });
    void (async () => {
      if (!(await engine.edit({ ...copy(draftSnapshot), attachments: [...draftSnapshot.attachments, ...entries] }))) return;
      after?.();
      const insert = inserterRef.current;
      if (insert) for (const entry of entries) insert(entry.id);
    })();
  }, [engine, intakePolicy]);

  // 文档级拖放（DSH installDocumentDropEvents 同款）：dragDepth 计数防止子元素穿越时遮罩闪烁；
  // dragleave 到视口边缘或 window dragend 兜底重置；dropEffect 随可用性为 copy/none；
  // 遮罩只做提示（pointer-events: none），不截获指针，accept/reject 由这里独占。
  useEffect(() => {
    const fileTransfer = (event: DragEvent): DataTransfer | null => {
      const dataTransfer = event.dataTransfer;
      return dataTransfer && dataTransfer.types.includes("Files") ? dataTransfer : null;
    };
    let depth = 0;
    const reset = () => {
      depth = 0;
      setDragActive(false);
    };
    const onDragEnter = (event: DragEvent) => {
      if (!fileTransfer(event)) return;
      event.preventDefault();
      depth += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      const dataTransfer = fileTransfer(event);
      if (!dataTransfer) return;
      event.preventDefault();
      dataTransfer.dropEffect = canAcceptDrop ? "copy" : "none";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!fileTransfer(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
      const leftViewport = event.clientX <= 0 || event.clientY <= 0
        || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
      if ((event.target === document.documentElement || event.target === document.body) && leftViewport) reset();
    };
    const onDrop = (event: DragEvent) => {
      const dataTransfer = fileTransfer(event);
      if (!dataTransfer) return;
      event.preventDefault();
      reset();
      if (!canAcceptDrop) return;
      runIntake(droppedBatch(dataTransfer));
    };
    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    window.addEventListener("dragend", reset);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", reset);
    };
  }, [canAcceptDrop, runIntake]);

  const limits = intakeLimitsText(intakePolicy ?? {});
  return <section className="chat-composer" aria-label="聊天输入框">
    <Editor
      engine={engine} placeholder={placeholder} registerAttachmentInserter={registerAttachmentInserter}
      registerAttachmentMover={registerAttachmentMover}
      completionProvider={completionProvider} intake={runIntake}
    />
    <AttachmentCards
      attachments={snapshot.attachments} disabled={view.admitting} onRemove={removeAttachment}
      attachmentOrder={documentAttachmentOrder} onMoveAttachment={onMoveAttachment}
    />
    <div className="composer-actions">
      <label>添加附件 <input data-testid="files" type="file" multiple disabled={view.admitting} onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        // 先清 value 再准入：选择同一个文件也能再次触发 change（DSH 同款）。
        event.target.value = "";
        if (!files.length) return;
        runIntake(files.map((file) => ({ file, directory: false })));
      }} /></label>
      <button type="button" data-testid="send" disabled={view.admitting || view.sending || !hasContent(snapshot) || view.closed} onClick={() => void engine.submit()}>发送</button>
      <button type="button" data-testid="take-queue" disabled={view.admitting || !isEmptyDraft(snapshot) || !view.state.submissions.some((item) => item.status === "queued")} onClick={() => void engine.takeLatestQueued()}>取回最近排队消息</button>
    </div>
    {intakeNotice && <p role="alert" data-testid="intake-warning">
      以下文件未添加：{intakeNotice}。其余输入不受影响，可继续发送。
      <button type="button" data-testid="intake-dismiss" aria-label="关闭文件提示" onClick={() => setIntakeNotice(null)}>知道了</button>
    </p>}
    <p role="status" data-testid="status">
      {view.admitting ? "正在可靠保存消息…" : view.sending ? "等待对端接纳，可继续写新草稿" : view.state.activeTurn ? "本轮运行中，按当前投递设置处理新消息" : "Enter 发送 · Shift+Enter 换行"}
      {view.dirty ? " · 当前输入尚未保存" : ""}
    </p>
    {dragActive && <DropOverlay
      disabled={!canAcceptDrop}
      title={canAcceptDrop ? "松开鼠标，把文件添加到消息" : "当前无法接收文件"}
      desc={canAcceptDrop ? (limits || "文件将作为草稿附件添加，随消息一起可靠保存") : undefined}
    />}
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
