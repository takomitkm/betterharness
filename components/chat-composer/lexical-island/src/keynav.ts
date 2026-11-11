// Enter/IME 仲裁与组合状态机——Rust composer-keynav (decide_enter) 的 DOM 同步镜像。
//
// 双源维护决定（D008）：Enter 仲裁必须与 DOM 事件同步执行（浏览器输入法不等人），
// 而 Rust keynav crate 是业务契约权威——两侧使用同一组测试向量（KD 契约子集，
// 见 tests/keynav.test.ts），任何一侧语义变更必须双侧同步 + 校机对拍。
//
// 本文件零 DOM 依赖：纯函数 + 显式注入时钟（与 archive/ts key-decision.ts 同语义）。

/// 组合结束后的保护窗口（毫秒）。DSH 核实值：10ms，判定用严格小于。
export const IME_GRACE_MS = 10;

export type VerdictKind = "hand-to-ime" | "submit" | "newline" | "menu" | "noop";

/** 一次 Enter 按键的裁决：kind 与 preventDefault 独立，宿主不许自行推断。 */
export interface KeyVerdict {
  kind: VerdictKind;
  preventDefault: boolean;
}

export interface ImeStateSnapshot {
  composing: boolean;
  composingUntilMs: number;
}

export interface EnterDecisionInput {
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
  composing: boolean;
  composingUntilMs: number;
  hasMenu: boolean;
  canSubmit: boolean;
}

/// Enter 仲裁，优先级从高到低（KD 契约，与 composer-keynav 同 fixtures）：
/// 0. 非 Enter → 不归本模块；1. 组合中 → 交输入法；2. 宽限期内（严格 <）→ 同；
/// 3. Shift/Alt+Enter → 换行不拦截；4. 菜单开着 → 只确认；5. repeat → 吞；
/// 6. 可提交 → 发送；7. 其余 → 吞。
export function decideEnter(input: EnterDecisionInput): KeyVerdict {
  if (input.key !== "Enter") {
    return { kind: "noop", preventDefault: false };
  }
  if (input.isComposing || input.keyCode === 229 || input.composing) {
    return { kind: "hand-to-ime", preventDefault: false };
  }
  if (input.nowMs < input.composingUntilMs) {
    return { kind: "hand-to-ime", preventDefault: false };
  }
  if (input.shiftKey || input.altKey) {
    return { kind: "newline", preventDefault: false };
  }
  if (input.hasMenu) {
    return { kind: "menu", preventDefault: true };
  }
  if (input.repeat) {
    return { kind: "noop", preventDefault: true };
  }
  if (input.canSubmit) {
    return { kind: "submit", preventDefault: true };
  }
  return { kind: "noop", preventDefault: true };
}

/// 宿主侧组合状态机：真实 compositionstart/compositionend 事件喂进来，
/// 快照交给 decideEnter。时钟由调用方注入。
export class ImeTracker {
  private composing = false;
  private composingUntilMs = 0;

  onCompositionStart(): void {
    this.composing = true;
  }

  onCompositionEnd(nowMs: number): void {
    this.composing = false;
    this.composingUntilMs = nowMs + IME_GRACE_MS;
  }

  isComposing(nowMs: number): ImeStateSnapshot {
    return {
      composing: this.composing || nowMs < this.composingUntilMs,
      composingUntilMs: this.composingUntilMs,
    };
  }

  reset(): void {
    this.composing = false;
    this.composingUntilMs = 0;
  }
}
