import { useEffect, useLayoutEffect, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import {
  $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, $setSelection,
  DecoratorNode, TextNode, KEY_ENTER_COMMAND, KEY_ARROW_UP_COMMAND, COMMAND_PRIORITY_HIGH, CLEAR_HISTORY_COMMAND, HISTORIC_TAG,
  type SerializedTextNode, type SerializedLexicalNode, type LexicalNode, type RangeSelection, type LexicalEditor as LexicalEditorInstance, type EditorState,
} from "lexical";
import type { EditorProps } from "./ChatComposer.tsx";
import type { AssetId, JsonValue, NodeId } from "./types.ts";
import { copy, isEmptyDraft, newNodeId } from "./snapshots.ts";
import { useComposerSubmission } from "./useComposerSubmission.ts";

type SerializedMention = SerializedTextNode & { referenceId: string };
/** 附件节点的序列化形态：只承载身份（NodeId + AssetId），字节与元数据都在附件条目上。 */
type SerializedAttachment = SerializedLexicalNode & { type: "composer-attachment"; version: 1; nodeId: NodeId; assetId: AssetId };

export class ComposerMentionNode extends TextNode {
  __referenceId: string;
  static getType(): string { return "composer-mention"; }
  static clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(node.__text, node.__referenceId, node.__key);
  }
  constructor(text: string, referenceId: string, key?: string) {
    super(text, key); this.__referenceId = referenceId;
  }
  static importJSON(value: SerializedMention): ComposerMentionNode {
    return new ComposerMentionNode(value.text, value.referenceId).updateFromJSON(value).setMode("token");
  }
  exportJSON(): SerializedMention {
    return { ...super.exportJSON(), type: "composer-mention", version: 1, referenceId: this.__referenceId };
  }
  createDOM(config: Parameters<TextNode["createDOM"]>[0]): HTMLElement {
    const element = super.createDOM(config); element.classList.add("mention"); return element;
  }
  isTextEntity(): boolean { return true; }
}

/** 正文中的附件节点：文档只记录身份，随节点移动/重排/恢复保持不变。 */
export class ComposerAttachmentNode extends DecoratorNode<null> {
  __nodeId: NodeId;
  __assetId: AssetId;
  static getType(): string { return "composer-attachment"; }
  static clone(node: ComposerAttachmentNode): ComposerAttachmentNode {
    return new ComposerAttachmentNode(node.__assetId, node.__nodeId, node.__key);
  }
  constructor(assetId: AssetId, nodeId: NodeId, key?: string) {
    super(key); this.__assetId = assetId; this.__nodeId = nodeId;
  }
  static importJSON(value: SerializedAttachment): ComposerAttachmentNode {
    // 恢复时保留原 NodeId/AssetId：节点身份不因重排、交接或重启而改变。
    return new ComposerAttachmentNode(value.assetId, value.nodeId).updateFromJSON(value);
  }
  exportJSON(): SerializedAttachment {
    return { ...super.exportJSON(), type: "composer-attachment", version: 1, nodeId: this.__nodeId, assetId: this.__assetId };
  }
  createDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "attachment";
    element.setAttribute("data-node-id", this.__nodeId);
    element.setAttribute("data-asset-id", this.__assetId);
    return element;
  }
  updateDOM(): false { return false; }
  // 基类默认即所需：isInline() 为 true（可与文字同行），decorate() 返回 null（芯片外观由
  // createDOM 的元素 + CSS 承担，无需 React 门户）。
}

/** 把附件节点插到当前选区：一次 editor.update 完成，NodeId 在创建时固定并随节点走。 */
export function insertAttachmentNode(
  editor: LexicalEditorInstance,
  assetId: AssetId,
  lastSelection?: { current: RangeSelection | null },
): void {
  editor.update(() => {
    const node = new ComposerAttachmentNode(assetId, newNodeId());
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      selection.insertNodes([node]);
      return;
    }
    // 文件选择器等交互会把焦点移出编辑器，此时活动选区为空；
    // 恢复最后记住的文本选区，让附件插回用户原来看的位置而不是段落末尾。
    const remembered = lastSelection?.current ?? null;
    if (remembered) {
      try {
        $setSelection(remembered.clone());
        const restored = $getSelection();
        if ($isRangeSelection(restored)) {
          restored.insertNodes([node]);
          return;
        }
      } catch {
        // 记忆选区引用的节点可能已被删除；走末尾追加兜底。
      }
    }
    const root = $getRoot();
    let paragraph = root.getLastChild();
    if (!paragraph) { paragraph = $createParagraphNode(); root.append(paragraph); }
    (paragraph as LexicalNode & { append(...nodes: LexicalNode[]): unknown }).append(node);
  });
}

function Integration({ engine, registerAttachmentInserter }: EditorProps) {
  const [editor] = useLexicalComposerContext();
  const view = useComposerSubmission(engine);
  const draft = view.state.draft;
  // 文件选择器抢焦点后活动选区为空；记住最后的文本选区，附件节点仍插回原位置。
  const lastSelectionRef = useRef<RangeSelection | null>(null);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) lastSelectionRef.current = selection.clone();
      });
    });
  }, [editor]);

  useEffect(() => {
    registerAttachmentInserter?.((assetId) => insertAttachmentNode(editor, assetId, lastSelectionRef));
    return () => registerAttachmentInserter?.(null);
  }, [editor, registerAttachmentInserter]);

  useLayoutEffect(() => {
    editor.setEditable(!view.admitting && !view.closed);
  }, [editor, view.admitting, view.closed]);

  useLayoutEffect(() => {
    const document = draft.snapshot.document;
    if (document?.format === "lexical") {
      const json = JSON.stringify(document.value);
      if (JSON.stringify(editor.getEditorState().toJSON()) !== json) {
        editor.setEditorState(editor.parseEditorState(json), { tag: "composer-sync" });
      }
    } else if (editor.getEditorState().read(() => $getRoot().getTextContent()) !== draft.snapshot.text) {
      editor.update(() => {
        const root = $getRoot(); root.clear();
        for (const line of draft.snapshot.text.split("\n\n")) {
          root.append($createParagraphNode().append($createTextNode(line)));
        }
        root.getLastChild()?.selectEnd();
      }, { discrete: true, tag: ["composer-sync", HISTORIC_TAG] });
    }
  }, [editor, draft.generation, draft.revision, draft.snapshot]);

  useLayoutEffect(() => {
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }, [editor, engine, draft.generation]);

  useEffect(() => {
    const enter = editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
      if (!event || event.isComposing || event.shiftKey || event.altKey) return false;
      engine.handleKey(event);
      return true;
    }, COMMAND_PRIORITY_HIGH);
    const up = editor.registerCommand(KEY_ARROW_UP_COMMAND, (event) => {
      if (!event || event.shiftKey || event.ctrlKey || event.metaKey || !isEmptyDraft(engine.getSnapshot().state.draft.snapshot)) return false;
      event.preventDefault(); void engine.takeLatestQueued(); return true;
    }, COMMAND_PRIORITY_HIGH);
    return () => { enter(); up(); };
  }, [editor, engine]);

  function onChange(state: EditorState, _editor: unknown, tags: Set<string>) {
    if (tags.has("composer-sync")) return;
    const current = engine.getSnapshot();
    if (current.admitting || current.closed) return;
    const value = state.toJSON();
    let text = "";
    const references: { id: string; kind: string; value: JsonValue }[] = [];
    state.read(() => {
      text = $getRoot().getTextContent();
      for (const node of $getRoot().getAllTextNodes()) {
        if (node instanceof ComposerMentionNode) references.push({
          id: node.__referenceId, kind: "mention", value: { label: node.getTextContent() },
        });
      }
    });
    const previous = current.state.draft.snapshot;
    if (previous.text === text && JSON.stringify(previous.document?.value) === JSON.stringify(value)) return;
    void engine.edit({
      ...copy(previous), text, references: [...copy(previous.references.filter((reference) => reference.kind !== "mention")), ...references],
      document: { format: "lexical", version: 1, value: value as unknown as JsonValue },
    });
  }

  return <>
    <OnChangePlugin onChange={onChange} ignoreSelectionChange />
    <button type="button" data-testid="mention" disabled={view.admitting} onClick={() => {
      editor.update(() => {
        const node = new ComposerMentionNode("@参考资料", crypto.randomUUID()).setMode("token");
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertNodes([node, $createTextNode(" ")]);
        else {
          const root = $getRoot();
          let paragraph = root.getLastChild();
          if (!paragraph) { paragraph = $createParagraphNode(); root.append(paragraph); }
          (paragraph as LexicalNode & { append(...nodes: LexicalNode[]): unknown }).append(node, $createTextNode(" "));
        }
      });
      editor.focus();
    }}>插入引用</button>
  </>;
}

/** Actual Lexical serialization, token nodes and restoration; no string-only rich-text substitute. */
export function LexicalEditor({ engine, placeholder, registerAttachmentInserter }: EditorProps) {
  return <LexicalComposer initialConfig={{
    namespace: "ReliableComposer", nodes: [ComposerMentionNode, ComposerAttachmentNode],
    theme: { paragraph: "composer-paragraph" }, onError(error) { throw error; },
  }}>
    <div className="rich-editor">
      <PlainTextPlugin
        contentEditable={<ContentEditable data-testid="editor" aria-label="消息" />}
        placeholder={<span className="placeholder">{placeholder}</span>}
        ErrorBoundary={LexicalErrorBoundary}
      />
    </div>
    <HistoryPlugin />
    <Integration engine={engine} registerAttachmentInserter={registerAttachmentInserter} />
  </LexicalComposer>;
}
