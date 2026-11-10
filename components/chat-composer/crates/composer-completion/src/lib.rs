//! 候选菜单纯状态机：触发检测、会话代次、高亮与选择写回计算，零依赖。
//! 语义移植自 archive/ts/completion.ts（对齐 DSH ui-input-trigger）：
//! - 从光标向前找最近的 @ 或 /；查询里不跨空白；触发符前不能是字母/数字/下划线；
//! - slash 额外排除 URL 的 `//` 与 `scheme:/`；
//! - 查询变更即换代次，旧查询的迟到结果按代次拒绝；pending 期间不可选中任何结果；
//! - 一次选择 = 一次写回 = 一步 Undo（写回由编辑器在单个事务里完成，本模块只给区间与文本）。
//!
//! 字符坐标约定：caret/start/end 以 **Unicode 字符**（char）计，不是 UTF-16 代码单元。
//! 平台适配层负责在 DOM（UTF-16）与本模块（char）之间换算，emoji/组合字符不得直传。

/// 触发种类：@ = reference，/ = slash。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriggerKind {
    Reference,
    Slash,
}

impl TriggerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TriggerKind::Reference => "reference",
            TriggerKind::Slash => "slash",
        }
    }
}

/// 光标处的活跃触发 token：区间为 [start, end)（char 下标），end 恒等于检测时的 caret。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TriggerHit {
    pub kind: TriggerKind,
    pub query: String,
    pub start: usize,
    pub end: usize,
}

/// 一个候选项：label 供菜单展示，insert_text 是写回正文的文本。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub label: String,
    pub insert_text: String,
}

/// 一次被接受的选择：宿主据此把 [start,end) 替换为 candidate.insert_text + 一个补尾空格。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedPick {
    pub kind: TriggerKind,
    pub query: String,
    pub start: usize,
    pub end: usize,
    pub candidate: Candidate,
    pub doc_rev: u64,
}

fn is_word_char(ch: char) -> bool {
    // TS \p{L}\p{N}_：字母/数字/下划线。出现在触发符之前说明 @xxx 是邮箱、路径等普通文本。
    ch.is_alphanumeric() || ch == '_'
}

/// 检测光标处是否有活跃触发 token（纯函数）。
/// 规则（v1，DSH 对齐的简化）：
/// - 从 caret-1 向前扫描，遇到 @ 或 / 即为触发符（最近的触发符获胜）；途中遇到空白则无触发；
/// - 触发符必须在文本开头，或前一个字符是空白/标点（前面是字母/数字/下划线就拒绝）；
/// - slash 额外拒绝 `//` 与 `scheme:/`（触发符前是冒号）；
/// - caret 为 0 或超出文本长度一律无触发。
pub fn detect_trigger(text: &str, caret: usize) -> Option<TriggerHit> {
    let chars: Vec<char> = text.chars().collect();
    if caret == 0 || caret > chars.len() {
        return None;
    }
    let mut index: isize = caret as isize - 1;
    while index >= 0 {
        let ch = chars[index as usize];
        if ch == '@' || ch == '/' {
            break;
        }
        if ch.is_whitespace() {
            return None;
        }
        index -= 1;
    }
    if index < 0 {
        return None;
    }
    let start = index as usize;
    let kind = if chars[start] == '@' {
        TriggerKind::Reference
    } else {
        TriggerKind::Slash
    };
    let query: String = chars[start + 1..caret].iter().collect();
    if start > 0 && is_word_char(chars[start - 1]) {
        return None;
    }
    if kind == TriggerKind::Slash {
        let before = if start > 0 {
            Some(chars[start - 1])
        } else {
            None
        };
        if before == Some('/') || before == Some(':') {
            return None;
        }
        if query.is_empty() && start + 1 < chars.len() && chars[start + 1] == '/' {
            return None;
        }
    }
    Some(TriggerHit {
        kind,
        query,
        start,
        end: caret,
    })
}

/// 纯文本写回计算：把 [start,end) 换成 replacement + 一个补尾空格，返回新文本与新光标。
pub fn apply_pick_to_text(text: &str, hit: &TriggerHit, replacement: &str) -> (String, usize) {
    let chars: Vec<char> = text.chars().collect();
    let mut next: String = chars[..hit.start].iter().collect();
    next.push_str(replacement);
    next.push(' ');
    next.extend(chars[hit.end..].iter());
    (next, hit.start + replacement.chars().count() + 1)
}

fn same_identity(a: &TriggerHit, b: &TriggerHit) -> bool {
    a.kind == b.kind && a.query == b.query && a.start == b.start && a.end == b.end
}

/// 菜单会话（纯状态，无时钟无副作用）。宿主每次编辑器更新调用 [`CompletionSession::track`]，
/// 候选到达后 [`CompletionSession::apply_candidates`]，键盘/指针走 move/set/accept/dismiss。
/// - 完全相同的 hit（kind+query+区间）保持状态：不换代次、不清候选、不动高亮；
/// - 新查询（kind 或 query 变了）递增 generation 并清空候选进入 pending；
/// - 同查询不同区间只更新锚点与 doc_rev，保留候选与高亮；
/// - dismiss/accept 记住关闭时的身份：完全相同的 token 不立刻重新弹出。
#[derive(Debug, Default)]
pub struct CompletionSession {
    hit: Option<TriggerHit>,
    doc_rev: u64,
    generation: u32,
    ready: Vec<Candidate>,
    highlight: isize,
    pending: bool,
    open: bool,
    dismissed: Option<TriggerHit>,
}

impl CompletionSession {
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前查询代次：宿主发起拉取前快照它，结果回来后交给 apply_candidates 校验。
    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// 已就绪的候选（pending 期间为空）。
    pub fn candidates(&self) -> &[Candidate] {
        &self.ready
    }

    /// 当前高亮下标；无高亮时为 -1。
    pub fn highlight_index(&self) -> isize {
        self.highlight
    }

    /// 当前触发的只读快照；关闭时为 None。
    pub fn hit(&self) -> Option<&TriggerHit> {
        self.hit.as_ref()
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// 结果未到（新查询已发出但 apply_candidates 还没被当前代次调用过）。
    pub fn is_pending(&self) -> bool {
        self.open && self.pending
    }

    pub fn track(&mut self, hit: Option<TriggerHit>, doc_rev: u64) {
        let Some(hit) = hit else {
            // 没有活跃触发：关闭但不记 dismiss 身份——光标离开不算用户拒绝，回到同一 token 允许重开。
            self.open = false;
            self.pending = false;
            self.ready.clear();
            self.highlight = -1;
            self.hit = None;
            self.doc_rev = doc_rev;
            return;
        };
        if self.open
            && self
                .hit
                .as_ref()
                .is_some_and(|current| same_identity(current, &hit))
        {
            // 完全相同的 token：保持候选与高亮，只刷新编辑版本。
            self.doc_rev = doc_rev;
            return;
        }
        if !self.open
            && self
                .dismissed
                .as_ref()
                .is_some_and(|dismissed| same_identity(dismissed, &hit))
        {
            return; // 刚被用户关掉的同一条目不立刻弹回（Esc / 选择后 / 点击外部）。
        }
        self.dismissed = None;
        let new_query = !self.open
            || !self
                .hit
                .as_ref()
                .is_some_and(|current| current.kind == hit.kind && current.query == hit.query);
        self.hit = Some(hit);
        self.doc_rev = doc_rev;
        if new_query {
            // AbortController 的纯替身：换代次后，旧请求即使照常返回也会被 apply_candidates 拒绝。
            self.generation += 1;
            self.ready.clear();
            self.highlight = -1;
            self.pending = true;
        }
        self.open = true;
    }

    /// 候选到达：代次与当前查询不匹配（或会话已关）时忽略并返回 false。第一个就绪候选自动高亮。
    pub fn apply_candidates(&mut self, generation: u32, candidates: Vec<Candidate>) -> bool {
        if !self.open || generation != self.generation {
            return false;
        }
        self.ready = candidates;
        self.pending = false;
        self.highlight = if self.ready.is_empty() { -1 } else { 0 };
        true
    }

    /// ↑/↓ 移动高亮，在就绪候选间循环；无候选时不动。
    pub fn move_highlight(&mut self, delta: isize) {
        let count = self.ready.len();
        if !self.open || count == 0 {
            return;
        }
        self.highlight =
            (((self.highlight + delta) % count as isize) + count as isize) % count as isize;
    }

    /// 直接定位高亮（鼠标悬停）；越界或无候选时不动。
    pub fn set_highlight(&mut self, index: usize) {
        if !self.open || index >= self.ready.len() {
            return;
        }
        self.highlight = index as isize;
    }

    pub fn highlighted(&self) -> Option<&Candidate> {
        if !self.open || self.highlight < 0 {
            return None;
        }
        self.ready.get(self.highlight as usize)
    }

    /// 接受当前高亮候选：pending 期间与无高亮时拒绝（返回 None）——宿主必须把 None 当作
    /// 「只吞掉 Enter，不发送也不写回」。成功时返回选择并关闭会话。
    pub fn accept(&mut self) -> Option<AcceptedPick> {
        let candidate = self.highlighted()?.clone();
        let hit = self.hit.as_ref()?;
        let pick = AcceptedPick {
            kind: hit.kind,
            query: hit.query.clone(),
            start: hit.start,
            end: hit.end,
            candidate,
            doc_rev: self.doc_rev,
        };
        self.close_with_dismissal();
        Some(pick)
    }

    /// 用户主动关闭（Esc / 点击外部）：记住身份，同一个 token 不立刻重新弹出。
    pub fn dismiss(&mut self) {
        if !self.open {
            return;
        }
        self.close_with_dismissal();
    }

    fn close_with_dismissal(&mut self) {
        if let Some(hit) = &self.hit {
            self.dismissed = Some(hit.clone());
        }
        self.open = false;
        self.pending = false;
        self.ready.clear();
        self.highlight = -1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(label: &str) -> Candidate {
        Candidate {
            label: label.into(),
            insert_text: label.into(),
        }
    }

    /// CT01：文本开头触发；只打触发符时查询为空。
    #[test]
    fn ct01_triggers_at_text_start_with_empty_query() {
        let hit = detect_trigger("@", 1).unwrap();
        assert_eq!(hit.kind, TriggerKind::Reference);
        assert_eq!(hit.query, "");
        assert_eq!((hit.start, hit.end), (0, 1));
    }

    /// CT02：空白/标点之后触发；字母/数字/下划线之后拒绝。
    #[test]
    fn ct02_boundary_rules_reject_word_contexts() {
        assert!(detect_trigger("a @", 3).is_some());
        assert!(detect_trigger("a./", 3).is_some(), "标点之后允许触发");
        assert!(
            detect_trigger("a@", 2).is_none(),
            "字母之后的 @ 是邮箱的一部分"
        );
        assert!(detect_trigger("a_/", 3).is_none());
        assert!(detect_trigger("a1/", 3).is_none());
    }

    /// CT03：查询不跨空白；最近的触发符获胜。
    #[test]
    fn ct03_query_cannot_cross_whitespace_and_nearest_trigger_wins() {
        let hit = detect_trigger("@a @b", 5).unwrap();
        assert_eq!(hit.query, "b");
        assert_eq!(hit.start, 3, "最近的触发符获胜");
        let hit = detect_trigger("@abc", 4).unwrap();
        assert_eq!(hit.query, "abc");
        assert!(detect_trigger("@ab cd", 6).is_none(), "查询跨空白 = 无触发");
        assert!(
            detect_trigger("@ab cd@", 7).is_none(),
            "字母后的触发符被边界规则拒绝"
        );
    }

    /// CT04：slash 的 URL 排除——`//` 与 `scheme:/` 不开菜单。
    #[test]
    fn ct04_slash_excludes_url_protocols_and_double_slashes() {
        assert!(detect_trigger("https://", 8).is_none(), "双斜杠");
        assert!(detect_trigger("http:/", 6).is_none(), "scheme:/");
        assert!(detect_trigger("s:/", 3).is_none());
        assert!(
            detect_trigger(" /", 2).is_some(),
            "空白后的普通 slash 仍然触发"
        );
    }

    /// CT05：@a→@ab 换代次进入 pending。
    #[test]
    fn ct05_query_change_bumps_generation_into_pending() {
        let mut session = CompletionSession::new();
        session.track(detect_trigger("@a", 2), 1);
        let generation = session.generation();
        session.apply_candidates(generation, vec![candidate("A")]);
        assert!(!session.is_pending());
        session.track(detect_trigger("@ab", 3), 2);
        assert!(session.is_pending());
        assert_eq!(session.generation(), generation + 1);
        assert!(session.candidates().is_empty(), "换代次清空候选");
    }

    /// CT06：纯光标移动不换查询代次，保留候选与高亮。
    #[test]
    fn ct06_caret_moves_without_text_change_keep_session() {
        let mut session = CompletionSession::new();
        session.track(detect_trigger("@ab", 3), 1);
        let generation = session.generation();
        session.apply_candidates(generation, vec![candidate("A"), candidate("B")]);
        session.set_highlight(1);
        session.track(detect_trigger("@ab", 3), 7);
        assert_eq!(session.generation(), generation);
        assert_eq!(session.candidates().len(), 2);
        assert_eq!(session.highlight_index(), 1);
    }

    /// CT07：迟到的旧查询结果被代次拒绝，绝不动当前高亮。
    #[test]
    fn ct07_stale_results_are_refused_by_generation() {
        let mut session = CompletionSession::new();
        session.track(detect_trigger("@a", 2), 1);
        let stale_generation = session.generation();
        session.track(detect_trigger("@ab", 3), 2);
        let fresh_generation = session.generation();
        assert!(fresh_generation != stale_generation);
        assert!(!session.apply_candidates(stale_generation, vec![candidate("old")]));
        assert!(session.candidates().is_empty());
        assert!(session.apply_candidates(fresh_generation, vec![candidate("new")]));
        assert_eq!(session.candidates()[0].label, "new");
    }

    /// CT08：pending / 无结果 / 无高亮时 accept 一律拒绝。
    #[test]
    fn ct08_accept_is_refused_while_pending_or_without_results() {
        let mut session = CompletionSession::new();
        session.track(detect_trigger("@a", 2), 1);
        assert!(session.accept().is_none(), "pending 期间不可选中");
        session.apply_candidates(session.generation(), vec![]);
        assert!(session.accept().is_none(), "空结果不可选中");
        session.track(detect_trigger("@ab", 3), 2);
        session.apply_candidates(session.generation(), vec![candidate("A"), candidate("B")]);
        session.dismiss();
        assert!(session.accept().is_none(), "已关闭的会话不可选中");
    }

    /// CT09：accept 返回完整选择（span + docRev）并关闭会话。
    #[test]
    fn ct09_accept_returns_the_full_pick_and_closes() {
        let mut session = CompletionSession::new();
        session.track(detect_trigger("@ab", 3), 42);
        session.apply_candidates(session.generation(), vec![candidate("Alice")]);
        let pick = session.accept().unwrap();
        assert_eq!(pick.start, 0);
        assert_eq!(pick.end, 3);
        assert_eq!(pick.candidate.insert_text, "Alice");
        assert_eq!(pick.doc_rev, 42);
        assert!(!session.is_open());
    }

    /// CT10：↑/↓ 在就绪候选间循环；空候选不动。
    #[test]
    fn ct10_move_highlight_cycles_and_ignores_empty() {
        let mut session = CompletionSession::new();
        session.track(detect_trigger("@a", 2), 1);
        session.apply_candidates(
            session.generation(),
            vec![candidate("A"), candidate("B"), candidate("C")],
        );
        session.move_highlight(1);
        assert_eq!(session.highlight_index(), 1);
        session.move_highlight(1);
        assert_eq!(session.highlight_index(), 2);
        session.move_highlight(1);
        assert_eq!(session.highlight_index(), 0, "循环");
        session.move_highlight(-1);
        assert_eq!(session.highlight_index(), 2, "反向循环");
        let mut empty = CompletionSession::new();
        empty.track(detect_trigger("@a", 2), 1);
        empty.apply_candidates(empty.generation(), vec![]);
        empty.move_highlight(1);
        assert_eq!(empty.highlight_index(), -1);
    }

    /// CT11：纯文本写回 = 区间替换 + 补尾空格，光标落在空格之后。
    #[test]
    fn ct11_apply_pick_replaces_span_and_lands_caret_after_space() {
        let hit = detect_trigger("@ab tail", 3).unwrap();
        let (text, caret) = apply_pick_to_text("@ab tail", &hit, "Alice");
        assert_eq!(
            text, "Alice  tail",
            "区间替换 + 补尾空格；tail 的前导空格保留（与 TS 一致）"
        );
        assert_eq!(caret, 6);
    }

    /// CT12：dismiss 身份保持——完全相同的 token 不立刻弹回，任何变化重新打开。
    #[test]
    fn ct12_dismissal_identity_keeps_identical_token_closed() {
        let mut session = CompletionSession::new();
        session.track(detect_trigger("@a", 2), 1);
        session.dismiss();
        assert!(!session.is_open());
        session.track(detect_trigger("@a", 2), 2);
        assert!(!session.is_open(), "同一 token 不闪回");
        session.track(detect_trigger("@ab", 3), 3);
        assert!(session.is_open(), "查询变了重新打开");
    }

    /// CT13：track(None) 不记 dismiss 身份——回到同一 token 允许重开。
    #[test]
    fn ct13_track_none_closes_without_dismissal_memory() {
        let mut session = CompletionSession::new();
        session.track(detect_trigger("@a", 2), 1);
        session.track(None, 2);
        assert!(!session.is_open());
        session.track(detect_trigger("@a", 2), 3);
        assert!(session.is_open());
    }

    /// CT14：关闭后重新打开会重新拉取（换代次），空结果是合法的非 pending 状态。
    #[test]
    fn ct14_reopening_refetches_and_empty_results_are_legal() {
        let mut session = CompletionSession::new();
        session.track(detect_trigger("@a", 2), 1);
        let first = session.generation();
        session.apply_candidates(first, vec![candidate("A")]);
        session.dismiss();
        session.track(detect_trigger("@b", 2), 2);
        assert_eq!(session.generation(), first + 1);
        assert!(session.is_pending());
        assert!(session.apply_candidates(session.generation(), vec![]));
        assert!(!session.is_pending(), "空结果是已就绪状态");
        assert!(session.accept().is_none());
    }
}
