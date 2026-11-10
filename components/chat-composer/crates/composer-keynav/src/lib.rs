//! Enter/IME 仲裁：纯函数 + 显式注入时钟，零依赖。
//! 语义移植自 archive/ts/key-decision.ts（对齐 DSH keymap.ts）：
//! - 组合中的 Enter（isComposing / 老式 keyCode 229 / 宿主组合状态）交给输入法；
//! - 组合刚结束的 IME_GRACE_MS 宽限期内仍按组合处理（Safari 把候选确认键再报成普通 Enter）；
//! - 「应用是否继续处理这个键」与「是否阻止浏览器默认行为」是两条独立决策，
//!   每个裁决都显式携带 prevent_default，宿主不许自行推断。

/// 组合结束后的保护窗口（毫秒）。DSH 核实值：10ms，判定用严格小于。
pub const IME_GRACE_MS: i64 = 10;

/// 裁决类别。prevent_default 由 [`KeyVerdict`] 单独携带——两者互相独立。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerdictKind {
    /// 交给输入法（停掉编辑器的 Enter 后备，但不拦截浏览器，让中文确认完成）。
    HandToIme,
    /// 发送。
    Submit,
    /// 明确换行（Shift/Alt+Enter；插入由浏览器或编辑器后备完成，不拦截默认行为）。
    Newline,
    /// 候选菜单开着：Enter 只确认菜单项，绝不能变成发送。
    Menu,
    /// 吞掉但不做任何事（空草稿、重复键、非 Enter 等）。
    Noop,
}

/// 一次 Enter 按键的裁决。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyVerdict {
    pub kind: VerdictKind,
    pub prevent_default: bool,
}

/// 输入法状态的纯数据快照（宿主把真实组合事件记入 [`ImeTracker`]，再把快照交给裁决）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct ImeStateSnapshot {
    pub composing: bool,
    pub composing_until_ms: i64,
}

/// 一次 Enter 按键的裁决输入。可选布尔字段对齐 TS 的 `?:`——缺省即 false。
#[derive(Clone, Debug, Default)]
pub struct EnterDecisionInput {
    pub key: String,
    pub shift_key: bool,
    pub alt_key: bool,
    pub ctrl_key: bool,
    pub meta_key: bool,
    pub is_composing: bool,
    /// 老式 keyCode 信号；229 表示组合中。
    pub key_code: Option<i64>,
    pub repeat: bool,
    /// 注入时钟：宿主与测试都必须显式提供，本 crate 不取系统时钟。
    pub now_ms: i64,
    /// 宿主记录的组合状态（[`ImeStateSnapshot::composing`]）。
    pub composing: bool,
    /// 宿主记录的宽限截止时刻（[`ImeStateSnapshot::composing_until_ms`]）。
    pub composing_until_ms: i64,
    /// 候选菜单是否开着。
    pub has_menu: bool,
    /// 当前草稿是否允许提交。
    pub can_submit: bool,
}

/// Enter 仲裁，优先级从高到低：
/// 0. 不是 Enter → 不归本模块管，明确不拦截；
/// 1. 组合进行中（isComposing / keyCode 229 / 宿主组合状态）→ 交给输入法；
/// 2. 组合结束后的宽限期内（now < composing_until，严格小于）→ 仍交给输入法；
/// 3. Shift/Alt+Enter → 明确换行；
/// 4. 候选菜单开着 → 只确认菜单项；
/// 5. 按住不放的自动重复 → 吞掉，防止连发；
/// 6. 可以提交 → 发送；
/// 7. 其余 → 吞掉但不做任何事。
pub fn decide_enter(input: &EnterDecisionInput) -> KeyVerdict {
    if input.key != "Enter" {
        return KeyVerdict {
            kind: VerdictKind::Noop,
            prevent_default: false,
        };
    }
    if input.is_composing || input.key_code == Some(229) || input.composing {
        return KeyVerdict {
            kind: VerdictKind::HandToIme,
            prevent_default: false,
        };
    }
    if input.now_ms < input.composing_until_ms {
        return KeyVerdict {
            kind: VerdictKind::HandToIme,
            prevent_default: false,
        };
    }
    if input.shift_key || input.alt_key {
        return KeyVerdict {
            kind: VerdictKind::Newline,
            prevent_default: false,
        };
    }
    if input.has_menu {
        return KeyVerdict {
            kind: VerdictKind::Menu,
            prevent_default: true,
        };
    }
    if input.repeat {
        return KeyVerdict {
            kind: VerdictKind::Noop,
            prevent_default: true,
        };
    }
    if input.can_submit {
        return KeyVerdict {
            kind: VerdictKind::Submit,
            prevent_default: true,
        };
    }
    KeyVerdict {
        kind: VerdictKind::Noop,
        prevent_default: true,
    }
}

/// 宿主侧组合状态机：真实 compositionstart/compositionend 事件喂进来，快照交给 [`decide_enter`]。
/// 时钟一律由调用方注入（now_ms），自身不取系统时间，保证可测。
#[derive(Clone, Copy, Debug, Default)]
pub struct ImeTracker {
    composing: bool,
    composing_until_ms: i64,
}

impl ImeTracker {
    pub fn on_composition_start(&mut self) {
        self.composing = true;
    }

    /// 组合结束后进入 IME_GRACE_MS 宽限窗口；窗口内 is_composing 仍报告 composing: true。
    pub fn on_composition_end(&mut self, now_ms: i64) {
        self.composing = false;
        self.composing_until_ms = now_ms + IME_GRACE_MS;
    }

    /// DSH 的 recentlyComposing 语义：组合中，或仍在结束后的宽限窗口内（严格小于）。
    pub fn is_composing(&self, now_ms: i64) -> ImeStateSnapshot {
        ImeStateSnapshot {
            composing: self.composing || now_ms < self.composing_until_ms,
            composing_until_ms: self.composing_until_ms,
        }
    }

    /// 根元素被替换时重置：旧根上未结束的组合状态不得泄漏进新根。
    pub fn reset(&mut self) {
        self.composing = false;
        self.composing_until_ms = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(now_ms: i64) -> EnterDecisionInput {
        EnterDecisionInput {
            key: "Enter".into(),
            now_ms,
            ..Default::default()
        }
    }

    /// KD01：组合进行中把 Enter 交给输入法，且不拦截浏览器默认行为。
    #[test]
    fn kd01_composing_hands_enter_to_ime_without_blocking() {
        let mut verdict = decide_enter(&EnterDecisionInput {
            is_composing: true,
            ..input(100)
        });
        assert_eq!(
            verdict,
            KeyVerdict {
                kind: VerdictKind::HandToIme,
                prevent_default: false
            }
        );
        verdict = decide_enter(&EnterDecisionInput {
            composing: true,
            ..input(100)
        });
        assert_eq!(verdict.kind, VerdictKind::HandToIme);
        assert!(!verdict.prevent_default);
    }

    /// KD02：老式 keyCode 229 即使 isComposing=false 也交给输入法。
    #[test]
    fn kd02_legacy_key_code_229_hands_to_ime() {
        let verdict = decide_enter(&EnterDecisionInput {
            key_code: Some(229),
            ..input(100)
        });
        assert_eq!(
            verdict,
            KeyVerdict {
                kind: VerdictKind::HandToIme,
                prevent_default: false
            }
        );
        // 其他 keyCode 不触发该分支。
        let verdict = decide_enter(&EnterDecisionInput {
            key_code: Some(13),
            ..input(100)
        });
        assert_eq!(verdict.kind, VerdictKind::Noop);
    }

    /// KD03：宽限窗口严格小于 IME_GRACE_MS——窗口内 hand-to-ime，边界时刻起按普通 Enter。
    #[test]
    fn kd03_grace_window_is_strict_and_exactly_ime_grace_ms() {
        let mut tracker = ImeTracker::default();
        tracker.on_composition_start();
        tracker.on_composition_end(1000);
        let snapshot = tracker.is_composing(1000 + IME_GRACE_MS - 1);
        assert!(snapshot.composing);
        let verdict = decide_enter(&EnterDecisionInput {
            composing: snapshot.composing,
            composing_until_ms: snapshot.composing_until_ms,
            ..input(1000 + IME_GRACE_MS - 1)
        });
        assert_eq!(verdict.kind, VerdictKind::HandToIme);
        let snapshot = tracker.is_composing(1000 + IME_GRACE_MS);
        assert!(!snapshot.composing);
    }

    /// KD04：Shift/Alt+Enter 是明确换行，且不拦截浏览器默认行为。
    #[test]
    fn kd04_shift_or_alt_enter_is_newline_leaving_default_alone() {
        let verdict = decide_enter(&EnterDecisionInput {
            shift_key: true,
            can_submit: true,
            ..input(100)
        });
        assert_eq!(
            verdict,
            KeyVerdict {
                kind: VerdictKind::Newline,
                prevent_default: false
            }
        );
        let verdict = decide_enter(&EnterDecisionInput {
            alt_key: true,
            can_submit: true,
            ..input(100)
        });
        assert_eq!(
            verdict,
            KeyVerdict {
                kind: VerdictKind::Newline,
                prevent_default: false
            }
        );
    }

    /// KD05：菜单开着时 Enter 被 Menu 裁决吞掉——绝不发送。
    #[test]
    fn kd05_open_menu_consumes_enter_before_repeat_or_submit() {
        let verdict = decide_enter(&EnterDecisionInput {
            has_menu: true,
            repeat: true,
            can_submit: true,
            ..input(100)
        });
        assert_eq!(
            verdict,
            KeyVerdict {
                kind: VerdictKind::Menu,
                prevent_default: true
            }
        );
    }

    /// KD06：按住不放的重复键是拦截型 no-op，即使草稿可提交。
    #[test]
    fn kd06_repeat_is_preventing_noop_even_when_submittable() {
        let verdict = decide_enter(&EnterDecisionInput {
            repeat: true,
            can_submit: true,
            ..input(100)
        });
        assert_eq!(
            verdict,
            KeyVerdict {
                kind: VerdictKind::Noop,
                prevent_default: true
            }
        );
    }

    /// KD07：不可提交的草稿（空、只读中）也是拦截型 no-op。
    #[test]
    fn kd07_unsubmittable_draft_is_preventing_noop() {
        let verdict = decide_enter(&input(100));
        assert_eq!(
            verdict,
            KeyVerdict {
                kind: VerdictKind::Noop,
                prevent_default: true
            }
        );
    }

    /// KD08：非 Enter 键明确不归本模块，绝不拦截。
    #[test]
    fn kd08_other_keys_are_explicitly_not_ours() {
        let verdict = decide_enter(&EnterDecisionInput {
            key: "a".into(),
            can_submit: true,
            ..input(100)
        });
        assert_eq!(
            verdict,
            KeyVerdict {
                kind: VerdictKind::Noop,
                prevent_default: false
            }
        );
    }

    /// KD09：Ctrl/Meta+Enter 仍然提交（文档化契约；引擎语义不变）。
    #[test]
    fn kd09_ctrl_or_meta_enter_still_submits() {
        for (ctrl, meta) in [(true, false), (false, true)] {
            let verdict = decide_enter(&EnterDecisionInput {
                ctrl_key: ctrl,
                meta_key: meta,
                can_submit: true,
                ..input(100)
            });
            assert_eq!(
                verdict,
                KeyVerdict {
                    kind: VerdictKind::Submit,
                    prevent_default: true
                }
            );
        }
    }

    /// KD10：ImeTracker 生命周期——开始、结束、宽限、重启、重置。
    #[test]
    fn kd10_ime_tracker_lifecycle() {
        let mut tracker = ImeTracker::default();
        assert!(!tracker.is_composing(0).composing);
        tracker.on_composition_start();
        assert!(tracker.is_composing(50).composing);
        tracker.on_composition_end(50);
        assert!(tracker.is_composing(55).composing, "宽限窗口内仍视为组合中");
        assert!(!tracker.is_composing(50 + IME_GRACE_MS).composing);
        tracker.on_composition_start();
        assert!(tracker.is_composing(60).composing, "重启组合");
        tracker.reset();
        assert!(!tracker.is_composing(60).composing);
        assert_eq!(tracker.is_composing(60).composing_until_ms, 0);
    }

    /// KD11：真实 ImeTracker 快照喂给 decide_enter，宽限边界成立。
    #[test]
    fn kd11_decide_enter_honors_real_tracker_snapshot_boundary() {
        let mut tracker = ImeTracker::default();
        tracker.on_composition_start();
        tracker.on_composition_end(500);
        let snapshot = tracker.is_composing(505);
        let verdict = decide_enter(&EnterDecisionInput {
            composing: snapshot.composing,
            composing_until_ms: snapshot.composing_until_ms,
            can_submit: true,
            ..input(505)
        });
        assert_eq!(verdict.kind, VerdictKind::HandToIme);
        let snapshot = tracker.is_composing(510);
        let verdict = decide_enter(&EnterDecisionInput {
            composing: snapshot.composing,
            composing_until_ms: snapshot.composing_until_ms,
            can_submit: true,
            ..input(510)
        });
        assert_eq!(
            verdict,
            KeyVerdict {
                kind: VerdictKind::Submit,
                prevent_default: true
            }
        );
    }
}
