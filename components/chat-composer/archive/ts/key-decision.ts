// Enter/IME 仲裁：纯函数 + 显式注入时钟，零依赖（不许 import react/lexical，Deno/Node 均可直接运行）。
// 语义对齐 DSH keymap.ts：
//   - 组合中的 Enter（isComposing / 老式 keyCode 229 / 宿主组合状态）交给输入法；
//   - 组合刚结束的 IME_GRACE_MS 宽限期内仍按组合处理（Safari 会把候选确认键再报成一次普通 Enter）；
//   - 「应用是否继续处理这个键」与「是否阻止浏览器默认行为」是两条独立决策：
//     hand-to-ime 停掉编辑器的 Enter 后备，但 preventDefault: false，让浏览器完成中文确认。

/** 组合结束后的保护窗口（毫秒）。DSH 核实值：10ms，判定用严格小于。 */
export const IME_GRACE_MS = 10;

/**
 * 一次 Enter 按键的裁决。kind 决定编辑器是否继续处理；preventDefault 决定是否拦截浏览器默认行为，
 * 两者互相独立：每个裁决都显式携带 preventDefault，宿主不许自行推断。
 */
export type KeyVerdict =
  | { kind: "hand-to-ime"; preventDefault: false }
  | { kind: "submit"; preventDefault: true }
  | { kind: "newline"; preventDefault: false }
  | { kind: "menu"; preventDefault: true }
  | { kind: "noop"; preventDefault: boolean };

/** 输入法状态的纯数据快照（不是类）：宿主把真实组合事件记入 ImeTracker，再把快照交给 decideEnter。 */
export interface ImeStateSnapshot {
  composing: boolean;
  composingUntilMs: number;
}

export interface EnterDecisionInput extends ImeStateSnapshot {
  key: string;
  shiftKey: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
  /** 注入时钟：宿主与测试都必须显式提供，模块内不许取 Date.now()。 */
  nowMs: number;
  hasMenu: boolean;
  canSubmit: boolean;
}

/**
 * Enter 仲裁，优先级从高到低：
 *   0. 不是 Enter → 不归本模块管，明确不拦截；
 *   1. 组合进行中（isComposing / keyCode 229 / 宿主组合状态）→ 交给输入法；
 *   2. 组合结束后的宽限期内（nowMs < composingUntilMs，严格小于）→ 仍交给输入法；
 *   3. Shift/Alt+Enter → 明确换行（换行的插入由浏览器或编辑器后备完成，因此不拦截默认行为）；
 *   4. 候选菜单开着 → Enter 只确认菜单项，绝不能变成发送；
 *   5. 按住不放的自动重复 → 吞掉，防止连发；
 *   6. 可以提交 → 发送；
 *   7. 其余（空草稿、只读中等）→ 吞掉但不做任何事。
 */
export function decideEnter(input: EnterDecisionInput): KeyVerdict {
  if (input.key !== "Enter") return { kind: "noop", preventDefault: false };
  if (input.isComposing || input.keyCode === 229 || input.composing) return { kind: "hand-to-ime", preventDefault: false };
  if (input.nowMs < input.composingUntilMs) return { kind: "hand-to-ime", preventDefault: false };
  if (input.shiftKey || input.altKey) return { kind: "newline", preventDefault: false };
  if (input.hasMenu) return { kind: "menu", preventDefault: true };
  if (input.repeat) return { kind: "noop", preventDefault: true };
  if (input.canSubmit) return { kind: "submit", preventDefault: true };
  return { kind: "noop", preventDefault: true };
}

/**
 * 宿主侧组合状态机：真实 compositionstart/compositionend 事件喂进来，快照交给 decideEnter。
 * 时钟一律由调用方注入（nowMs），自身不取 Date.now()，保证可测。
 */
export class ImeTracker {
  private composing = false;
  private composingUntilMs = 0;

  onCompositionStart(): void {
    this.composing = true;
  }

  /** 组合结束后进入 IME_GRACE_MS 宽限窗口；窗口内 isComposing 仍报告 composing: true。 */
  onCompositionEnd(nowMs: number): void {
    this.composing = false;
    this.composingUntilMs = nowMs + IME_GRACE_MS;
  }

  /** DSH 的 recentlyComposing 语义：组合中，或仍在结束后的宽限窗口内（严格小于）。 */
  isComposing(nowMs: number): ImeStateSnapshot {
    return {
      composing: this.composing || nowMs < this.composingUntilMs,
      composingUntilMs: this.composingUntilMs,
    };
  }

  /** 根元素被替换时重置（DSH 同款）：旧根上未结束的组合状态不得泄漏进新根。 */
  reset(): void {
    this.composing = false;
    this.composingUntilMs = 0;
  }
}
