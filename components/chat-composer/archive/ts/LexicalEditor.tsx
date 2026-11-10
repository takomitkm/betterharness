import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import {
  $createParagraphNode, $createRangeSelection, $createTextNode, $getRoot, $getSelection, $getNearestNodeFromDOMNode,
  $isElementNode, $isRangeSelection,
  $isTextNode, $setSelection, DecoratorNode, TextNode, KEY_ENTER_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ARROW_DOWN_COMMAND,
  KEY_ESCAPE_COMMAND, PASTE_COMMAND, COPY_COMMAND, CUT_COMMAND, COMMAND_PRIORITY_HIGH, CLEAR_HISTORY_COMMAND, HISTORIC_TAG,
  type SerializedTextNode, type SerializedLexicalNode, type LexicalNode, type RangeSelection, type ElementNode,
  type LexicalEditor as LexicalEditorInstance, type EditorState,
} from "lexical";
import type { EditorProps, IntakeFile } from "./ChatComposer.tsx";
import type { AssetId, JsonValue, NodeId } from "./types.ts";
import { copy, hasContent, isEmptyDraft, newNodeId } from "./snapshots.ts";
import { computeMoveSpan } from "./reorder.ts";
import { splitClipboard } from "./intake.ts";
import { ImeTracker, decideEnter } from "./key-decision.ts";
import { CompletionSession, detectTrigger, type AcceptedPick } from "./completion.ts";
import { CandidateMenu } from "./CandidateMenu.tsx";
import { useComposerSubmission } from "./useComposerSubmission.ts";

/**
 * 附件节点复制/粘贴的私有剪贴板 MIME（Element 同款思路）：
 * 复制时把选中附件节点的 AssetId 列表写进剪贴板，粘贴时优先识别——同草稿内
 * 粘贴 = 新节点引用同一资产（字节零拷贝，attachments 列表不变）；资产不在当前
 * 草稿（跨草稿粘贴或已移除）时放弃 MIME 走常规路径，绝不凭 MIME 造悬空引用。
 */
export const COMPOSER_CLIPBOARD_MIME = "application/x-betterharness-composer-attachment";

/** 解析剪贴板 MIME 载荷：[{ assetId: string }] 形状（与 COPY/CUT 写入方一致）；坏形状返回空数组。 */
function parseAttachmentClipboard(raw: string): AssetId[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    for (const entry of value) {
      if (entry !== null && typeof entry === "object" && typeof (entry as { assetId?: unknown }).assetId === "string") {
        ids.push((entry as { assetId: string }).assetId);
      }
    }
    return ids as AssetId[];
  } catch {
    return [];
  }
}

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

/**
 * 把多个附件节点按顺序插到当前选区：一次 editor.update = 一步撤销（剪贴板粘贴路径用）。
 * 每个节点拿到全新 NodeId（文档内 NodeId 必须唯一），assetId 由调用方保证已存在本草稿——
 * 同一资产因此可以被多个节点引用（复制附件卡片 = 引用复制，字节不复制）。
 */
export function insertAttachmentNodes(editor: LexicalEditorInstance, assetIds: readonly AssetId[]): void {
  if (!assetIds.length) return;
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    selection.insertNodes(assetIds.map((assetId) => new ComposerAttachmentNode(assetId, newNodeId())));
  });
}

/** 按文档顺序枚举全部附件节点（深度优先，与序列化 JSON 的遍历顺序一致）。 */
function $collectAttachmentNodes(): ComposerAttachmentNode[] {
  const found: ComposerAttachmentNode[] = [];
  const visit = (element: ElementNode): void => {
    for (const child of element.getChildren()) {
      if (child instanceof ComposerAttachmentNode) found.push(child);
      else if ($isElementNode(child)) visit(child);
    }
  };
  visit($getRoot());
  return found;
}

/**
 * 光标紧邻的附件节点（键盘移动的目标），以 DOM 选区为事实源——方向键移动光标是浏览器
 * 原生行为，Lexical 的内部选区在 composer-sync setEditorState 之后可能停留在文档起点且
 * 不随原生移动回同步（实测），不能拿内部选区当光标位置。解析规则：
 * 元素容器按子节点序号（offset-1 处的附件紧贴光标之前、offset 处紧贴之后）；文本容器只在
 * 光标位于文本端点时按该节点的前/后兄弟解析，在文本中间则无紧邻附件。
 * 两个附件紧贴光标两侧时按移动方向取：向右移取光标前的那个，向左移取光标后的那个；
 * 只有一个紧邻附件时无论方向都取它。必须在 editor.read() 内调用。
 */
function $domAdjacentAttachment(rootElement: HTMLElement, direction: 1 | -1): ComposerAttachmentNode | null {
  const domSelection = rootElement.ownerDocument.getSelection();
  if (domSelection === null || domSelection.rangeCount === 0) return null;
  const range = domSelection.getRangeAt(0);
  if (!rootElement.contains(range.startContainer)) return null;
  const container = range.startContainer;
  const offset = range.startOffset;
  if (container.nodeType === container.TEXT_NODE) {
    const textNode = $getNearestNodeFromDOMNode(container);
    if (textNode === null || !$isTextNode(textNode)) return null;
    if (offset !== 0 && offset !== textNode.getTextContentSize()) return null;
    const sibling = offset === 0 ? textNode.getPreviousSibling() : textNode.getNextSibling();
    return sibling instanceof ComposerAttachmentNode ? sibling : null;
  }
  if (container.nodeType !== container.ELEMENT_NODE) return null;
  const domChildren = container.childNodes;
  const beforeDom = offset > 0 ? domChildren[offset - 1] : null;
  const afterDom = offset < domChildren.length ? domChildren[offset] : null;
  const beforeNode = beforeDom === null ? null : $getNearestNodeFromDOMNode(beforeDom);
  const afterNode = afterDom === null ? null : $getNearestNodeFromDOMNode(afterDom);
  const beforeCaret = beforeNode instanceof ComposerAttachmentNode ? beforeNode : null;
  const afterCaret = afterNode instanceof ComposerAttachmentNode ? afterNode : null;
  return direction === 1 ? beforeCaret ?? afterCaret : afterCaret ?? beforeCaret;
}

/**
 * 把 assetId 对应的附件节点移动到「整篇文档附件节点序列」的第 targetIndex 位（0 起，
 * 语义见 reorder.ts）：按文档顺序枚举全部 composer-attachment 节点，目标越界钳制到
 * [0, 数量-1]，已在目标位时无操作。插入位置：摘除后其余附件的第 targetIndex 个之前；
 * 目标是末位时插在最后一个其余附件之后；没有其余附件时追加到文档最后一个段落。
 * 跨段落移动天然支持——锚点附件在哪个段落，节点就插到哪个段落。
 * 一次 editor.update = 一步 Undo；节点实例原样摘除再插回，Lexical key 与 NodeId/AssetId
 * 不变，React 不重挂载，rail 的 object-URL 不重建。引擎不参与移动（不变量）：移动只改
 * 文档顺序，outbox 与 attachments 列表一概不动，新顺序经 onChange 正常回写草稿。
 */
export function moveAttachmentNode(editor: LexicalEditorInstance, assetId: AssetId, targetIndex: number): void {
  editor.update(() => {
    const nodes = $collectAttachmentNodes();
    const span = computeMoveSpan(
      nodes.map((node) => ({ nodeId: node.__nodeId, assetId: node.__assetId })),
      assetId, targetIndex,
    );
    if (!span) return;

    const node = nodes[span.removeFrom];
    const remaining = nodes.filter((_, index) => index !== span.removeFrom);
    node.remove();
    if (span.insertAt < remaining.length) {
      remaining[span.insertAt].insertBefore(node);
    } else if (remaining.length > 0) {
      remaining[remaining.length - 1].insertAfter(node);
    } else {
      const root = $getRoot();
      const last = root.getLastChild();
      if ($isElementNode(last)) {
        last.append(node);
      } else {
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        paragraph.append(node);
      }
    }
  });
}

interface PlainSegment { node: TextNode; start: number; end: number; }
interface PlainWalk { text: string; segments: PlainSegment[]; }

/** 在当前选区插入 text/plain 原文（有文件伴随的粘贴用；DSH 消费纯文本而不是 HTML）。 */
function insertPlainText(editor: LexicalEditorInstance, text: string): void {
  editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) selection.insertText(text);
  });
}

/**
 * 按文档顺序展开纯文本与各文本节点的偏移区间（mention token 也按其文本参与）。
 * 块级元素之间补一个「\n」分隔：触发检测只要求 (text, caret) 自洽且不跨块，无需与
 * getTextContent 的换行约定逐字一致；快照 text 仍由 onChange 用 getTextContent 负责。
 */
function walkPlainText(root: ElementNode): PlainWalk {
  const segments: PlainSegment[] = [];
  let text = "";
  const visit = (element: ElementNode): void => {
    for (const child of element.getChildren()) {
      if ($isTextNode(child)) {
        segments.push({ node: child, start: text.length, end: text.length + child.getTextContentSize() });
        text += child.getTextContent();
      } else if ($isElementNode(child)) {
        visit(child);
        if (!child.isInline()) text += "\n";
      }
    }
  };
  visit(root);
  return { text, segments };
}

/** 把文本选区锚点换算成 walkPlainText 坐标系的光标偏移；元素锚点（空段落等）v1 视为无触发。 */
function caretOf(selection: RangeSelection, walk: PlainWalk): number | null {
  const anchor = selection.anchor;
  if (anchor.type !== "text") return null;
  for (const segment of walk.segments) {
    if (segment.node.getKey() === anchor.key) return segment.start + anchor.offset;
  }
  return null;
}

/** 命中起点落在 mention token 自己的文本里（如「插入引用」按钮写回的芯片）不算活跃触发。 */
function startsInsideMentionToken(walk: PlainWalk, offset: number): boolean {
  return walk.segments.some((segment) =>
    segment.node instanceof ComposerMentionNode && offset >= segment.start && offset < segment.end
  );
}

/**
 * 一次选择 = 一次 editor.update = 一步 Undo：把 [start,end) 替换为候选——
 * @ 写成 reference token 节点 + 补尾空格，/ 按纯文本回显 + 补尾空格——光标落在空格之后。
 * 补尾空格同时让写回后的文本不再命中触发（配合会话的 dismiss 身份双保险）。
 */
function applyCompletionPick(editor: LexicalEditorInstance, pick: AcceptedPick): void {
  editor.update(() => {
    const walk = walkPlainText($getRoot());
    const covering = walk.segments.filter((segment) => segment.end > pick.start && segment.start < pick.end);
    if (!covering.length) return;
    const first = covering[0];
    const last = covering[covering.length - 1];
    const from = pick.start - first.start;
    const to = pick.end - last.start;
    // 删除区间：边界节点局部拼接删除，中间节点整删（程序化改动不受 token 模式限制）。
    if (first.node === last.node) {
      first.node.spliceText(from, to - from, "", false);
    } else {
      first.node.spliceText(from, first.node.getTextContentSize() - from, "", false);
      for (let index = 1; index < covering.length - 1; index++) covering[index].node.remove();
      last.node.spliceText(0, to, "", false);
    }
    const selection = $createRangeSelection();
    selection.anchor.set(first.node.getKey(), from, "text");
    selection.focus.set(first.node.getKey(), from, "text");
    $setSelection(selection);
    const trailing = $createTextNode(" ");
    if (pick.kind === "reference") {
      const mention = new ComposerMentionNode(pick.candidate.insertText, crypto.randomUUID()).setMode("token");
      selection.insertNodes([mention, trailing]);
    } else {
      selection.insertNodes([$createTextNode(pick.candidate.insertText), trailing]);
    }
    // 光标显式落到补尾空格之后：下次检测从空格前扫描，不会立刻重开菜单。
    const after = $createRangeSelection();
    after.anchor.set(trailing.getKey(), 1, "text");
    after.focus.set(trailing.getKey(), 1, "text");
    $setSelection(after);
  });
}

/** CandidateMenu 的渲染镜像：会话是可变对象，React 只订阅这份快照。 */
interface MenuMirror {
  pending: boolean;
  highlightIndex: number;
  options: { key: string; label: string }[];
}

function Integration({ engine, registerAttachmentInserter, registerAttachmentMover, completionProvider, intake }: EditorProps) {
  const [editor] = useLexicalComposerContext();
  const view = useComposerSubmission(engine);
  const draft = view.state.draft;
  // 文件选择器抢焦点后活动选区为空；记住最后的文本选区，附件节点仍插回原位置。
  const lastSelectionRef = useRef<RangeSelection | null>(null);
  // Enter/IME 仲裁：根元素上的真实组合事件喂给 tracker，Enter 裁决统一交给 key-decision。
  const imeRef = useRef<ImeTracker | null>(null);
  if (!imeRef.current) imeRef.current = new ImeTracker();
  // 候选菜单会话（completion.ts 纯状态机）；React 只镜像它给 CandidateMenu，不反向持有引擎逻辑。
  const completionRef = useRef<CompletionSession | null>(null);
  if (!completionRef.current) completionRef.current = new CompletionSession();
  const providerRef = useRef<EditorProps["completionProvider"]>(completionProvider);
  // 本地编辑的在途握手：编辑器发出的文档 JSON + 发起时的引擎版本。引擎发布到超过
  // 发起版本的任何状态（含在途编辑自身的回显）即握手完成。握手未完成前禁止
  // composer-sync 用旧草稿重置编辑器——否则「附件条目先落、节点编辑在途」的中间
  // 渲染会把刚插入的节点吞掉（文件添加两步流程的真实竞争）。
  const inFlightRef = useRef<{ json: string; dispatchedRevision: number } | null>(null);
  // 文本版本（只随正文文本变化递增）与最近一次检测到的文本；光标纯移动不推进版本。
  const docRevRef = useRef(0);
  const menuTextRef = useRef<string | null>(null);
  const [menuMirror, setMenuMirror] = useState<MenuMirror | null>(null);

  useEffect(() => { providerRef.current = completionProvider; }, [completionProvider]);

  const syncMenuMirror = useCallback(() => {
    const session = completionRef.current!;
    if (!session.isOpen()) {
      setMenuMirror((previous) => (previous === null ? previous : null));
      return;
    }
    setMenuMirror({
      pending: session.pending(),
      highlightIndex: session.highlightIndex,
      options: session.candidates.map((candidate, index) => ({ key: `${index}:${candidate.insertText}`, label: candidate.label })),
    });
  }, []);

  // 在途握手清账：引擎发布到超过发起版本的任何状态都算窗口结束（编辑自身被拒绝时，
  // 下一次成功的发布同样解锁同步）。同步效果的顶部守卫消费这个标记。
  useEffect(() => engine.subscribe(() => {
    const inFlight = inFlightRef.current;
    if (inFlight === null) return;
    const draft = engine.getSnapshot().state.draft;
    if (draft.revision > inFlight.dispatchedRevision || JSON.stringify(draft.snapshot.document?.value) === inFlight.json) {
      inFlightRef.current = null;
    }
  }), [engine]);

  useEffect(() => {
    const ime = imeRef.current!;
    const start = () => ime.onCompositionStart();
    const end = () => ime.onCompositionEnd(Date.now());
    let attached: HTMLElement | null = null;
    const detach = () => {
      attached?.removeEventListener("compositionstart", start);
      attached?.removeEventListener("compositionend", end);
      attached = null;
    };
    return editor.registerRootListener((root) => {
      detach();
      // 根元素被替换时重置组合状态（DSH 同款）：旧根上未结束的组合不得泄漏进新根。
      ime.reset();
      if (root) {
        root.addEventListener("compositionstart", start);
        root.addEventListener("compositionend", end);
        attached = root;
      }
    });
  }, [editor]);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) lastSelectionRef.current = selection.clone();
      });
    });
  }, [editor]);

  // 触发检测：每次编辑器更新（含纯光标移动）都重算；组合输入中不检测。
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has("composer-sync")) {
        // 宿主整体替换编辑器状态（草稿恢复/交接清空）：直接关闭菜单，不在这份状态上做触发检测。
        completionRef.current!.track(null, docRevRef.current);
        syncMenuMirror();
        return;
      }
      if (!editor.isEditable()) return;
      if (imeRef.current!.isComposing(Date.now()).composing) return;
      const session = completionRef.current!;
      const provider = providerRef.current;
      editorState.read(() => {
        const walk = walkPlainText($getRoot());
        if (menuTextRef.current !== walk.text) {
          menuTextRef.current = walk.text;
          docRevRef.current += 1;
        }
        const selection = $getSelection();
        const caret = $isRangeSelection(selection) ? caretOf(selection, walk) : null;
        let hit = caret === null ? null : detectTrigger(walk.text, caret);
        if (hit && startsInsideMentionToken(walk, hit.start)) hit = null;
        if (!provider) {
          session.track(null, docRevRef.current);
          return;
        }
        const generationBefore = session.generation;
        session.track(hit, docRevRef.current);
        if (hit && session.isOpen() && session.generation !== generationBefore) {
          // 新查询：向宿主候选源拉取；迟到的旧结果由会话按代次拒绝（纯化的 AbortController）。
          const generation = session.generation;
          const { kind, query } = hit;
          void Promise.resolve().then(() => provider(kind, query)).then(
            (candidates) => {
              session.applyCandidates(generation, Array.isArray(candidates) ? candidates : []);
              syncMenuMirror();
            },
            () => {
              session.applyCandidates(generation, []);
              syncMenuMirror();
            },
          );
        }
      });
      syncMenuMirror();
    });
  }, [editor, syncMenuMirror]);

  // 菜单键盘仲裁（↑/↓/Esc）：先于取回队列等既有处理器注册；菜单未开时一律放行，不影响既有行为。
  useEffect(() => {
    const moveHighlight = (delta: number) => (event: KeyboardEvent | null): boolean => {
      if (!event) return false;
      // 组合优先：组合中的方向键属于输入法。
      if (imeRef.current!.isComposing(Date.now()).composing) return false;
      const session = completionRef.current!;
      if (!session.isOpen()) return false;
      event.preventDefault();
      session.moveHighlight(delta);
      syncMenuMirror();
      return true;
    };
    const down = editor.registerCommand(KEY_ARROW_DOWN_COMMAND, moveHighlight(1), COMMAND_PRIORITY_HIGH);
    const up = editor.registerCommand(KEY_ARROW_UP_COMMAND, moveHighlight(-1), COMMAND_PRIORITY_HIGH);
    const escape = editor.registerCommand(KEY_ESCAPE_COMMAND, (event) => {
      if (!event) return false;
      // 组合优先：组合中的 Esc 属于输入法（取消组合），不动菜单。
      if (imeRef.current!.isComposing(Date.now()).composing) return false;
      const session = completionRef.current!;
      if (!session.isOpen()) return false;
      event.preventDefault();
      session.dismiss();
      syncMenuMirror();
      return true;
    }, COMMAND_PRIORITY_HIGH);
    return () => { down(); up(); escape(); };
  }, [editor, syncMenuMirror]);

  useEffect(() => {
    registerAttachmentInserter?.((assetId) => insertAttachmentNode(editor, assetId, lastSelectionRef));
    return () => registerAttachmentInserter?.(null);
  }, [editor, registerAttachmentInserter]);

  // 移动入口（rail 卡片「前移/后移」的落点）：与插入入口同款注册模式。引擎不参与移动，
  // 这里只是把目标下标转发给 moveAttachmentNode（一次 editor.update = 一步 Undo）。
  useEffect(() => {
    registerAttachmentMover?.((assetId, targetAttachmentIndex) => moveAttachmentNode(editor, assetId, targetAttachmentIndex));
    return () => registerAttachmentMover?.(null);
  }, [editor, registerAttachmentMover]);

  // 键盘兜底：光标紧邻附件节点时，Ctrl/Cmd+Shift+→/← 把该节点移过后一个/前一个附件节点
  // （同方向没有更多附件时由 clamp 钳到端点 = 无操作）。与菜单（↑/↓/Esc）、Enter 仲裁、
  // 粘贴键位不重叠，互不影响；组合中的方向键属于输入法，只读窗口不移动。
  // 注意：不能走 Lexical 的 KEY_ARROW_*_COMMAND——Lexical 的 isMoveForward 掩码未声明
  // ctrlKey 时按「必须为 false」匹配（matchModifier: undefined || false），Ctrl/Cmd+Shift+方向键
  // 既不匹配 isMoveForward 也不匹配 isMoveToEnd，命令根本不会派发；所以同 DSH 的
  // registerComposerKeymap 一样，直接在编辑器根元素挂原生 keydown。
  // 目标解析以 DOM 选区为事实源（$domAdjacentAttachment），不读 Lexical 内部选区。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (direction === 0 || !event.shiftKey || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (imeRef.current!.isComposing(Date.now()).composing || !editor.isEditable()) return;
      const root = editor.getRootElement();
      if (!root) return;
      // 用 editor.read（而非 editorState.read）：$getNearestNodeFromDOMNode 需要活动编辑器
      // 才能查 DOM→节点映射，editorState.read 只设状态不设编辑器，会抛 "no active editor"。
      const target = editor.read(() => {
        const adjacent = $domAdjacentAttachment(root, direction);
        if (!adjacent) return null;
        const currentIndex = $collectAttachmentNodes().findIndex((node) => node.getKey() === adjacent.getKey());
        return currentIndex < 0 ? null : { assetId: adjacent.__assetId, targetIndex: currentIndex + direction };
      });
      if (!target) return;
      event.preventDefault();
      moveAttachmentNode(editor, target.assetId, target.targetIndex);
    };
    // 根元素经 registerRootListener 挂/摘监听：本 effect 可能先于 Lexical 注册根元素执行，
    // getRootElement() 当时为 null 会让监听器永远装不上；根元素替换时也要跟着换。
    return editor.registerRootListener((root, previousRoot) => {
      if (previousRoot) previousRoot.removeEventListener("keydown", onKeyDown);
      if (root) root.addEventListener("keydown", onKeyDown);
    });
  }, [editor]);

  // 复制/剪切附件节点：往剪贴板追加私有 MIME（AssetId 列表，见 COMPOSER_CLIPBOARD_MIME）。
  // 只加料不消费：返回 false 让 Lexical 的默认复制/剪切（HTML、纯文本、剪切删除）照常进行；
  // 选区里没有附件节点时不写 MIME（空串会误触发粘贴分支，也让普通文本复制保持纯净）。
  useEffect(() => {
    const onClipboard = (event: ClipboardEvent | null): boolean => {
      if (!event || !event.clipboardData) return false;
      const entries = editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return [];
        return selection.getNodes()
          .filter((node): node is ComposerAttachmentNode => node instanceof ComposerAttachmentNode)
          .map((node) => ({ assetId: node.__assetId }));
      });
      if (!entries.length) return false;
      event.clipboardData.setData(COMPOSER_CLIPBOARD_MIME, JSON.stringify(entries));
      return false;
    };
    const copy = editor.registerCommand(COPY_COMMAND, onClipboard, COMMAND_PRIORITY_HIGH);
    const cut = editor.registerCommand(CUT_COMMAND, onClipboard, COMMAND_PRIORITY_HIGH);
    return () => { copy(); cut(); };
  }, [editor]);

  // 粘贴（DSH PASTE_COMMAND 同款）：在事件处理器内同步读 clipboardData——await 之后剪贴板即失效。
  // 路由用 splitClipboard 判定：无文件时返回 false 交给 Lexical 默认粘贴（纯文本路径不变）；
  // 有文件时 preventDefault 并统一准入（候选菜单开着也一样——粘贴不经过菜单会话，
  // 菜单随后按普通文本变化重新检测触发，与打字一致）。一次粘贴文件与文本可以并存：
  // 文件先准入，text/plain 原文在条目落盘后由 after 插入（此时选区已随文件调用更新，
  // 附件节点最终落在选区末端之后，与 DSH 的 after-the-selection-end 一致）；
  // 文件准入被拒也不吞同剪贴板的文字（after 照常执行）。
  useEffect(() => {
    return editor.registerCommand(PASTE_COMMAND, (event) => {
      // Lexical 的粘贴载荷可能是剪贴板事件，也可能是触发粘贴的键盘事件；
      // 只有真剪贴板事件带 clipboardData，其余交给 Lexical 默认处理。
      if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
      const dataTransfer = event.clipboardData;
      // 私有 MIME 优先于文件/文本路由（Element 同款）：同草稿粘贴附件卡片 = 新节点引用
      // 同一资产，一步撤销、字节零拷贝、attachments 列表不动。资产必须已在本草稿快照；
      // 跨草稿或资产已移除时放弃 MIME 走常规路径，绝不造悬空引用。
      const mime = dataTransfer.getData(COMPOSER_CLIPBOARD_MIME);
      if (mime) {
        const assetIds = parseAttachmentClipboard(mime);
        const known = new Set(engine.getSnapshot().state.draft.snapshot.attachments.map((asset) => asset.id));
        if (assetIds.length > 0 && assetIds.every((assetId) => known.has(assetId))) {
          event.preventDefault();
          insertAttachmentNodes(editor, assetIds);
          return true;
        }
      }
      const items = [...dataTransfer.items];
      const split = splitClipboard(items);
      if (!split.hasFiles) return false;
      event.preventDefault();
      const batch: IntakeFile[] = [];
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (!file) continue;
        const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
        batch.push({ file, directory: entry?.isDirectory === true });
      }
      const text = split.hasText ? dataTransfer.getData("text/plain") : "";
      intake?.(batch, text ? () => insertPlainText(editor, text) : undefined);
      return true;
    }, COMMAND_PRIORITY_HIGH);
  }, [editor, engine, intake]);

  useLayoutEffect(() => {
    editor.setEditable(!view.admitting && !view.closed);
  }, [editor, view.admitting, view.closed]);

  useLayoutEffect(() => {
    // 在途握手未完成：引擎里还是本地编辑发生前的旧状态，不能用旧草稿重置编辑器。
    if (inFlightRef.current !== null) return;
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
      if (!event) return false;
      const nowMs = Date.now();
      const ime = imeRef.current!.isComposing(nowMs);
      const current = engine.getSnapshot();
      const verdict = decideEnter({
        key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
        isComposing: event.isComposing, keyCode: event.keyCode, repeat: event.repeat ?? false,
        composing: ime.composing, composingUntilMs: ime.composingUntilMs, nowMs,
        // 候选菜单开着时 Enter 只确认菜单项（KD05：菜单裁决先于 repeat/submit）。
        hasMenu: completionRef.current!.isOpen(),
        canSubmit: !current.admitting && !current.closed && !current.sending && hasContent(current.state.draft.snapshot),
      });
      if (verdict.preventDefault) event.preventDefault();
      switch (verdict.kind) {
        case "hand-to-ime": return true; // 只停掉 Lexical 的 Enter 后备，不拦截浏览器——中文确认交给输入法。
        case "submit": engine.handleKey(event); return true; // 既有提交路径：preventDefault + 引擎自有守卫不变。
        case "newline": return false; // 交回 Lexical 纯文本后备插入换行（DSH：Shift+Enter 返回 false），不能自己吞掉默认行为。
        case "menu": {
          // 菜单确认：写回候选（一次 editor.update = 一步 Undo）后关闭会话，绝不落到发送。
          // pending 或无高亮时 accept() 返回 null：只吞掉这次 Enter，不发送也不写回。
          const session = completionRef.current!;
          const pick = session.accept();
          if (pick && pick.docRev === docRevRef.current) applyCompletionPick(editor, pick);
          syncMenuMirror();
          return true;
        }
        case "noop": return true;
      }
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
    // 在途握手登记：本地发出的文档在引擎回显（或版本推进）前，composer-sync 不得用旧草稿重置编辑器。
    inFlightRef.current = { json: JSON.stringify(value), dispatchedRevision: current.state.draft.revision };
    void engine.edit({
      ...copy(previous), text, references: [...copy(previous.references.filter((reference) => reference.kind !== "mention")), ...references],
      document: { format: "lexical", version: 1, value: value as unknown as JsonValue },
    });
  }

  return <>
    <CandidateMenu
      open={menuMirror !== null}
      pending={menuMirror?.pending ?? false}
      options={menuMirror?.options ?? []}
      highlightIndex={menuMirror?.highlightIndex ?? -1}
      onHighlight={(index) => {
        completionRef.current!.setHighlight(index);
        syncMenuMirror();
      }}
      onPick={(index) => {
        // 菜单行点击：mousedown 已阻止默认夺焦，编辑器选区未丢；直接按行选择写回。
        const session = completionRef.current!;
        session.setHighlight(index);
        const pick = session.accept();
        if (pick && pick.docRev === docRevRef.current) applyCompletionPick(editor, pick);
        syncMenuMirror();
      }}
      onDismiss={() => {
        completionRef.current!.dismiss();
        syncMenuMirror();
      }}
    />
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
export function LexicalEditor({ engine, placeholder, registerAttachmentInserter, registerAttachmentMover, completionProvider, intake }: EditorProps) {
  return <LexicalComposer initialConfig={{
    namespace: "ReliableComposer", nodes: [ComposerMentionNode, ComposerAttachmentNode],
    theme: { paragraph: "composer-paragraph" }, onError(error) { throw error; },
  }}>
    {/* Integration 排在编辑器之前：菜单 overlay 因此渲染在输入框上方（composer 卡片内）。 */}
    <Integration engine={engine} registerAttachmentInserter={registerAttachmentInserter} registerAttachmentMover={registerAttachmentMover} completionProvider={completionProvider} intake={intake} />
    <div className="rich-editor">
      <PlainTextPlugin
        contentEditable={<ContentEditable data-testid="editor" aria-label="消息" />}
        placeholder={<span className="placeholder">{placeholder}</span>}
        ErrorBoundary={LexicalErrorBoundary}
      />
    </div>
    <HistoryPlugin />
  </LexicalComposer>;
}
