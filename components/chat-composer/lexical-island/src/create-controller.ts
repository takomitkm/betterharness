// Lexical Island Vanilla Controller（Plan A+ Phase 1 PoC，PRODUCT-LINE-PLAN §四）。
//
// 唯一管理 Lexical 实例的对象：创建（createEditor）+ 挂载（setRootElement）+ 事件接线
// （registerPlainText / registerHistory / registerUpdateListener / 根级 composition 监听
// / Enter 仲裁）+ 命令（setDocument/clear/setDisabled/destroy）。
//
// DOM 所有权纪律（计划 §4.4）：
// - 宿主（Dioxus/测试页）只提供容器 div 并拥有它；
// - Lexical 拥有容器内的编辑器 DOM（contenteditable 子树）；
// - 本 Controller 挂载时把 root 塞进容器、销毁时清空容器并解除全部监听；
// - 同一容器重复 mount = 显式报错（双重初始化是失效模式 1）。
//
// 与 React 参考实现的差异：无 useLexicalComposerContext / PlainTextPlugin /
// HistoryPlugin / OnChangePlugin——分别由 createEditor+setRootElement /
// registerPlainText / registerHistory / registerUpdateListener 替代（映射表见
// docs/architecture/plan-a-plus-migration-inventory.md §3）。
//
// PoC 范围排除（计划 §4.7 外，进 A3）：completion 菜单、附件节点、剪贴板 MIME 定制。

import {
  $getRoot,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import { registerPlainText } from "@lexical/plain-text";
import { decideEnter, ImeTracker } from "./keynav.ts";

export type EditorCommand =
  | { type: "focus" }
  | { type: "clear" }
  | { type: "set-disabled"; value: boolean };

export type EditorEvent =
  | { type: "ready"; instanceId: string }
  | { type: "document-changed" }
  | { type: "submit-request" }
  | { type: "error"; message: string };

export interface LexicalController {
  /** 只读编辑器句柄（测试/宿主读取状态用；业务操作走命令与事件）。 */
  readonly editor: LexicalEditor;
  focus(): void;
  blur(): void;
  clear(): void;
  getPlainText(): string;
  getDocument(): string;
  setDocument(stateJson: string): void;
  setDisabled(disabled: boolean): void;
  /** 注入时钟读取（测试用）：当前组合状态快照。 */
  imeState(): { composing: boolean; composingUntilMs: number };
  destroy(): void;
}

export interface CreateControllerOptions {
  /** 宿主拥有的容器 div；Controller 在其内创建 contenteditable root。 */
  container: HTMLElement;
  placeholder?: string;
  /** Enter 裁决的宿主输入（菜单状态、可提交状态由宿主业务侧供给）。 */
  canSubmit: () => boolean;
  hasMenu?: () => boolean;
  /** 事件出口：document-changed / submit-request / error。 */
  onEvent: (event: EditorEvent) => void;
  /** 注入时钟（测试显式提供；默认 Date.now）。 */
  now?: () => number;
}

let instanceCounter = 0;

/** 创建 Vanilla Controller：容器 → Lexical root → 全部 vanilla 注册。 */
export function createController(options: CreateControllerOptions): LexicalController {
  const { container, onEvent, canSubmit, hasMenu = () => false } = options;
  const now = options.now ?? (() => Date.now());
  if (container.querySelector("[data-lexical-root]") !== null) {
    throw new Error("lexical island: 同一容器重复初始化（双重初始化是失效模式 1）");
  }

  instanceCounter += 1;
  const instanceId = `lexical-island-${instanceCounter}`;
  const editor = createEditor({
    namespace: instanceId,
    theme: { paragraph: "lexical-island-paragraph" },
    onError(error) {
      onEvent({ type: "error", message: String(error) });
    },
  });

  // root：Lexical 拥有该元素及其子树（DOM 所有权边界标记）。
  const root = document.createElement("div");
  root.setAttribute("contenteditable", "true");
  root.setAttribute("data-lexical-root", instanceId);
  root.setAttribute("data-testid", "editor");
  root.setAttribute("aria-label", "消息");
  root.className = "lexical-island-root";
  root.style.whiteSpace = "pre-wrap";
  container.appendChild(root);
  editor.setRootElement(root);

  // placeholder：纯 DOM/CSS 处理（PlainTextPlugin 的 React placeholder 之外做法）。
  const placeholderNode = document.createElement("div");
  placeholderNode.className = "lexical-island-placeholder";
  placeholderNode.textContent = options.placeholder ?? "";
  placeholderNode.style.position = "absolute";
  container.style.position = "relative";
  container.appendChild(placeholderNode);

  // 注册清单（destroy 时按 LIFO 全部解除——可逆副作用，失效模式 2：销毁残留）。
  const unregisterFns: Array<() => void> = [];
  const ime = new ImeTracker();

  // 纯文本编辑接线：beforeinput/keydown/paste/composition 系统事件 → Lexical 命令。
  unregisterFns.push(registerPlainText(editor));
  // 撤销栈。
  const historyState = createEmptyHistoryState();
  unregisterFns.push(registerHistory(editor, historyState, 300));

  // 根级 composition 监听（DSH 同款）：旧根未结束的组合不得泄漏进新根。
  const compositionStart = () => ime.onCompositionStart();
  const compositionEnd = () => ime.onCompositionEnd(now());
  root.addEventListener("compositionstart", compositionStart);
  root.addEventListener("compositionend", compositionEnd);

  // Enter 仲裁：decideEnter 裁决后走 submit-request 事件（业务状态归 Rust Core）。
  unregisterFns.push(
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (event === null) return false;
        const imeSnapshot = ime.isComposing(now());
        const verdict = decideEnter({
          key: event.key,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          isComposing: event.isComposing,
          keyCode: event.keyCode,
          repeat: event.repeat,
          nowMs: now(),
          composing: imeSnapshot.composing,
          composingUntilMs: imeSnapshot.composingUntilMs,
          hasMenu: hasMenu(),
          canSubmit: canSubmit(),
        });
        if (verdict.preventDefault) event.preventDefault();
        if (verdict.kind === "hand-to-ime") {
          // DOM 护栏：真实 IME 下浏览器默认动作本被输入法抑制，preventDefault 是无害冗余；
          // 合成/降级环境下（无真实 IME），默认 Enter 会直接改写 contenteditable 并在
          // composition 收尾时炸掉编辑器状态——必须拦下。textarea 路径的 catch-all
          // prevent_default 语义与此对齐。（Lexical 在组合期间不派发本命令——D009 实录，
          // 此分支守的是组合结束后 10ms 宽限窗内的 Enter。）
          event.preventDefault();
        }
        if (verdict.kind === "submit") onEvent({ type: "submit-request" });
        return verdict.kind !== "newline" && verdict.kind !== "hand-to-ime";
      },
      COMMAND_PRIORITY_HIGH,
    ),
  );

  // 文档变更事件 + placeholder 可见性。
  unregisterFns.push(
    editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const text = $getRoot().getTextContent();
        placeholderNode.style.display = text.length === 0 ? "" : "none";
      });
      onEvent({ type: "document-changed" });
    }),
  );

  return {
    editor,
    focus() {
      root.focus();
    },
    blur() {
      root.blur();
    },
    clear() {
      editor.update(() => {
        $getRoot().clear();
      });
    },
    getPlainText() {
      return editor.getEditorState().read(() => $getRoot().getTextContent());
    },
    getDocument() {
      return JSON.stringify(editor.getEditorState().toJSON());
    },
    setDocument(stateJson: string) {
      // 恢复路径（FM09 同族）：parseEditorState + historic 标记（不污染撤销栈）。
      const parsed = editor.parseEditorState(stateJson);
      editor.setEditorState(parsed);
      editor.update(() => {
        $getRoot().markDirty();
      }, { tag: "historic" });
    },
    setDisabled(disabled: boolean) {
      editor.setEditable(!disabled);
    },
    imeState() {
      return ime.isComposing(now());
    },
    destroy() {
      // 可逆副作用 LIFO 回收：监听/历史/root 全部解除（失效模式 2：销毁残留）。
      root.removeEventListener("compositionstart", compositionStart);
      root.removeEventListener("compositionend", compositionEnd);
      for (let index = unregisterFns.length - 1; index >= 0; index -= 1) {
        unregisterFns[index]();
      }
      unregisterFns.length = 0;
      editor.setRootElement(null);
      root.remove();
      placeholderNode.remove();
    },
  };

  void instanceId;
}
