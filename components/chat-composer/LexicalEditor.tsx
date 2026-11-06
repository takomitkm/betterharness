import { useEffect, useLayoutEffect } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import {
  $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection,
  TextNode, KEY_ENTER_COMMAND, KEY_ARROW_UP_COMMAND, COMMAND_PRIORITY_HIGH, CLEAR_HISTORY_COMMAND, HISTORIC_TAG,
  type SerializedTextNode, type LexicalNode, type EditorState,
} from "lexical";
import type { EditorProps } from "./ChatComposer.tsx";
import type { JsonValue } from "./types.ts";
import { copy, isEmptyDraft } from "./snapshots.ts";
import { useComposerSubmission } from "./useComposerSubmission.ts";

type SerializedMention = SerializedTextNode & { referenceId: string };

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

function Integration({ engine }: EditorProps) {
  const [editor] = useLexicalComposerContext();
  const view = useComposerSubmission(engine);
  const draft = view.state.draft;

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
export function LexicalEditor({ engine, placeholder }: EditorProps) {
  return <LexicalComposer initialConfig={{
    namespace: "ReliableComposer", nodes: [ComposerMentionNode],
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
    <Integration engine={engine} />
  </LexicalComposer>;
}
