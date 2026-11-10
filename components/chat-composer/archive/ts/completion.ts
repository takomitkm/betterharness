// 候选菜单纯状态机：触发检测、会话代次、高亮与选择写回计算（零依赖，不许 import react/lexical，
// Deno/Node 均可直接运行）。语义对齐 DSH ui-input-trigger 的 detect/menu/controller：
//   - 从光标向前找最近的 @ 或 /；查询里不跨空白；触发符前不能是字母/数字/下划线；
//   - slash 额外排除 URL 的 `//` 与 `scheme:/`（如 http:/、S:/），普通路径/网址不开菜单；
//   - 查询变更即换代次（本模块用递增 generation 充当 AbortController 的纯替身），
//     旧查询的迟到结果按代次拒绝；pending 期间不可选中任何结果，Enter 也不得变成发送；
//   - 一次选择 = 一次写回 = 一步 Undo（写回由编辑器在单个事务里完成，本模块只给区间与替换文本）。
// 这是 v1 简化版：没有 DSH 的带引号路径语法、多来源分组与 drill-down；查询是不透明字符串交给宿主。

export type TriggerKind = "reference" | "slash";

/** 光标处的活跃触发 token：区间为 [start, end)，end 恒等于检测时的 caret。 */
export interface TriggerHit {
  kind: TriggerKind;
  query: string;
  start: number;
  end: number;
}

/** 一个候选项：label 供菜单展示，insertText 是写回正文的文本（rich 模式 mention 节点也用它）。 */
export interface Candidate {
  label: string;
  insertText: string;
}

/** 一次被接受的选择：宿主据此把 [start,end) 替换为 candidate.insertText + 一个补尾空格。 */
export interface AcceptedPick {
  kind: TriggerKind;
  query: string;
  start: number;
  end: number;
  candidate: Candidate;
  docRev: number;
}

const WHITESPACE = /\s/;
/** 字母/数字/下划线：出现在触发符之前说明 @xxx 是邮箱、路径等普通文本的一部分，不算触发。 */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * 检测光标处是否有活跃触发 token。
 * 规则（v1，DSH 对齐的简化）：
 *   - 从 caret-1 向前扫描，遇到 @ 或 / 即为触发符（最近的触发符获胜）；途中遇到空白则无触发；
 *   - 触发符必须在文本开头，或前一个字符是空白/标点（即：前面是字母/数字/下划线就拒绝）；
 *   - slash 额外拒绝 `//`（含空查询时后面紧跟的 /）与 `scheme:/`（触发符前是冒号）；
 *   - caret 越界（<=0 或超出文本）一律无触发。
 */
export function detectTrigger(text: string, caret: number): TriggerHit | null {
  if (caret <= 0 || caret > text.length) return null;
  let index = caret - 1;
  while (index >= 0) {
    const ch = text[index];
    if (ch === "@" || ch === "/") break;
    if (WHITESPACE.test(ch)) return null;
    index--;
  }
  if (index < 0) return null;
  const kind: TriggerKind = text[index] === "@" ? "reference" : "slash";
  const start = index;
  const query = text.slice(start + 1, caret);
  if (start > 0 && WORD_CHAR.test(text[start - 1])) return null;
  if (kind === "slash") {
    const before = text[start - 1];
    if (before === "/" || before === ":") return null;
    if (query === "" && text[start + 1] === "/") return null;
  }
  return { kind, query, start, end: caret };
}

/** 纯文本写回计算：把 [start,end) 换成 replacement + 一个补尾空格，返回新文本与新光标。 */
export function applyPickToText(text: string, hit: TriggerHit, replacement: string): { text: string; caret: number } {
  return {
    text: text.slice(0, hit.start) + replacement + " " + text.slice(hit.end),
    caret: hit.start + replacement.length + 1,
  };
}

type DismissalIdentity = { kind: TriggerKind; query: string; start: number; end: number };

const sameIdentity = (a: DismissalIdentity, b: DismissalIdentity): boolean =>
  a.kind === b.kind && a.query === b.query && a.start === b.start && a.end === b.end;

/**
 * 菜单会话（纯状态，无时钟无副作用）。宿主每次编辑器更新调用 track()，候选到达后 applyCandidates()，
 * 键盘/指针操作走 moveHighlight/setHighlight/accept/dismiss。
 * - 完全相同的 hit（kind+query+区间）保持状态：不换代次、不清候选、不动高亮；
 * - 新查询（kind 或 query 变了）递增 generation 并清空候选进入 pending；
 * - 同查询不同区间（文本在其他地方变了）只更新锚点与 docRev，保留候选与高亮；
 * - dismiss()/accept() 记住关闭时的身份：完全相同的 token 不立刻重新弹出（Esc 后不闪回、
 *   选择写回的文本若仍含触发符也不会递归重开）。
 */
export class CompletionSession {
  private hitValue: TriggerHit | null = null;
  private docRevValue = 0;
  private generationValue = 0;
  private ready: Candidate[] = [];
  private highlightValue = -1;
  private pendingValue = false;
  private openValue = false;
  private dismissed: DismissalIdentity | null = null;

  /** 当前查询代次：宿主发起拉取前快照它，结果回来后交给 applyCandidates 校验。 */
  get generation(): number {
    return this.generationValue;
  }

  /** 已就绪的候选（pending 期间为空——v1 用骨架行替代 DSH 的「保留旧行但禁选」）。 */
  get candidates(): readonly Candidate[] {
    return this.ready;
  }

  /** 当前高亮下标；无高亮时为 -1。 */
  get highlightIndex(): number {
    return this.highlightValue;
  }

  /** 当前触发的只读快照；关闭时为 null。 */
  get hit(): TriggerHit | null {
    return this.hitValue;
  }

  isOpen(): boolean {
    return this.openValue;
  }

  /** 结果未到（新查询已发出但 applyCandidates 还没被当前代次调用过）。 */
  pending(): boolean {
    return this.openValue && this.pendingValue;
  }

  track(hit: TriggerHit | null, docRev: number): void {
    if (!hit) {
      // 没有活跃触发：关闭但不记 dismiss 身份——光标离开不算用户拒绝，回到同一 token 允许重开。
      this.openValue = false;
      this.pendingValue = false;
      this.ready = [];
      this.highlightValue = -1;
      this.hitValue = null;
      this.docRevValue = docRev;
      return;
    }
    if (this.openValue && this.hitValue && sameIdentity(this.hitValue, hit)) {
      // 完全相同的 token：保持候选与高亮，只刷新编辑版本。
      this.docRevValue = docRev;
      return;
    }
    if (!this.openValue && this.dismissed && sameIdentity(this.dismissed, hit)) {
      return; // 刚被用户关掉的同一条目不立刻弹回（Esc / 选择后 / 点击外部）。
    }
    this.dismissed = null;
    const newQuery = !this.openValue || !this.hitValue || this.hitValue.kind !== hit.kind || this.hitValue.query !== hit.query;
    this.hitValue = { ...hit };
    this.docRevValue = docRev;
    if (newQuery) {
      // AbortController 的纯替身：换代次后，旧请求即使照常返回也会被 applyCandidates 拒绝。
      this.generationValue += 1;
      this.ready = [];
      this.highlightValue = -1;
      this.pendingValue = true;
    }
    this.openValue = true;
  }

  /** 候选到达：代次与当前查询不匹配（或会话已关）时忽略并返回 false。第一个就绪候选自动高亮。 */
  applyCandidates(generation: number, candidates: readonly Candidate[]): boolean {
    if (!this.openValue || generation !== this.generationValue) return false;
    this.ready = [...candidates];
    this.pendingValue = false;
    this.highlightValue = this.ready.length ? 0 : -1;
    return true;
  }

  /** ↑/↓ 移动高亮，在就绪候选间循环；无候选时不动。 */
  moveHighlight(delta: number): void {
    const count = this.ready.length;
    if (!this.openValue || count === 0) return;
    this.highlightValue = (((this.highlightValue + delta) % count) + count) % count;
  }

  /** 直接定位高亮（鼠标悬停）；越界或无候选时不动。 */
  setHighlight(index: number): void {
    if (!this.openValue || index < 0 || index >= this.ready.length) return;
    this.highlightValue = index;
  }

  highlighted(): Candidate | null {
    if (!this.openValue || this.highlightValue < 0) return null;
    return this.ready[this.highlightValue] ?? null;
  }

  /**
   * 接受当前高亮候选：pending 期间（新查询结果未到）与无高亮时拒绝（返回 null），
   * 宿主必须把 null 当作「只吞掉 Enter，不发送也不写回」。成功时返回选择并关闭会话。
   */
  accept(): AcceptedPick | null {
    const candidate = this.highlighted();
    if (!candidate || this.pendingValue || !this.hitValue) return null;
    const pick: AcceptedPick = {
      kind: this.hitValue.kind,
      query: this.hitValue.query,
      start: this.hitValue.start,
      end: this.hitValue.end,
      candidate,
      docRev: this.docRevValue,
    };
    this.closeWithDismissal();
    return pick;
  }

  /** 用户主动关闭（Esc / 点击外部）：记住身份，同一个 token 不立刻重新弹出。 */
  dismiss(): void {
    if (!this.openValue) return;
    this.closeWithDismissal();
  }

  private closeWithDismissal(): void {
    if (this.hitValue) this.dismissed = { ...this.hitValue };
    this.openValue = false;
    this.pendingValue = false;
    this.ready = [];
    this.highlightValue = -1;
  }
}
