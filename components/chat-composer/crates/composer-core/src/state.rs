//! Durable composer state: draft, outbox ledger, and turn bookkeeping.
//!
//! Ownership discipline this crate buys over the TypeScript version:
//! * `handoff` consumes the draft by value, so a stale handle cannot observe or
//!   mutate the message that was already sent.
//! * every ledger mutation goes through `Ledger`, and a result can only settle
//!   the attempt it belongs to.
//! * `Uncertain` has no automatic exit: no retry, no restore, no removal.

use crate::ids::{
    validate_result, AttemptId, Delivery, DeliveryResult, GenerationId, MessageId, ReceiptError,
    ScopeId, Status, TurnId,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Editor payload captured for one submission. Bytes live outside this struct
/// (in the JS binding) because attachments are host-owned blobs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub text: String,
    pub attachment_ids: Vec<String>,
    pub reference_ids: Vec<String>,
}

impl Snapshot {
    pub fn text(text: impl Into<String>) -> Self {
        Snapshot {
            text: text.into(),
            attachment_ids: Vec::new(),
            reference_ids: Vec::new(),
        }
    }

    /// Whitespace is real user input: it must not be treated as an empty draft.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.attachment_ids.is_empty() && self.reference_ids.is_empty()
    }

    /// Whether this snapshot has anything worth submitting.
    pub fn has_content(&self) -> bool {
        !self.text.trim().is_empty()
            || !self.attachment_ids.is_empty()
            || !self.reference_ids.is_empty()
    }
}

/// One editable draft with its own generation and revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Draft {
    pub generation: GenerationId,
    pub revision: u64,
    pub snapshot: Snapshot,
}

/// One message in the outbox.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Submission {
    pub id: MessageId,
    pub scope: ScopeId,
    pub source_generation: GenerationId,
    pub snapshot: Snapshot,
    pub status: Status,
    pub delivery: Delivery,
    pub queued_for_turn: Option<TurnId>,
    pub attempt: Option<AttemptId>,
    pub attempts: u32,
    pub created_at_ms: u64,
    pub reason: Option<String>,
}

/// Everything persisted for one scope: this is the unit of atomic persistence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeState {
    pub schema: u32,
    pub scope: ScopeId,
    pub revision: u64,
    pub draft: Draft,
    /// `Vec` keeps FIFO order; `accepted_ids` makes duplicate settlement cheap.
    pub submissions: Vec<Submission>,
    pub active_turn: Option<TurnId>,
    pub finished_turns: BTreeSet<TurnId>,
    /// Ledger entries whose durable write failed; retried by `flush`.
    pub pending_receipts: Vec<PendingReceipt>,
}

/// A host result that arrived but could not be written yet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingReceipt {
    pub id: MessageId,
    pub attempt: Option<AttemptId>,
    pub result: DeliveryResult,
}

/// Mutating operations that a caller may request on the ledger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerError {
    NotFound,
    WrongStatus,
    /// A late result from another attempt; ignore rather than corrupt state.
    StaleAttempt,
    /// `Uncertain` was settled to `Uncertain` again — keep it, do not downgrade.
    NoProgress,
    DuplicateId,
}

impl ScopeState {
    pub fn new(scope: ScopeId, generation: GenerationId) -> Self {
        ScopeState {
            schema: 1,
            scope,
            revision: 0,
            draft: Draft {
                generation,
                revision: 0,
                snapshot: Snapshot::text(""),
            },
            submissions: Vec::new(),
            active_turn: None,
            finished_turns: BTreeSet::new(),
            pending_receipts: Vec::new(),
        }
    }

    fn find(&self, id: &MessageId) -> Option<&Submission> {
        self.submissions.iter().find(|item| &item.id == id)
    }

    fn find_mut(&mut self, id: &MessageId) -> Option<&mut Submission> {
        self.submissions.iter_mut().find(|item| &item.id == id)
    }

    /// Replace the draft content, allocating a new revision. Never touches the outbox.
    pub fn edit(&mut self, snapshot: Snapshot) {
        self.draft.snapshot = snapshot;
        self.draft.revision = self.draft.revision.saturating_add(1);
    }

    /// Atomically move the current draft payload into the outbox and open a new
    /// empty draft. Returns the message ID so the caller can dispatch it.
    ///
    /// Callers must persist the resulting `ScopeState` before observing the
    /// returned ID as "sent"; this function only mutates in memory.
    pub fn handoff(
        &mut self,
        message: MessageId,
        next_generation: GenerationId,
        delivery: Delivery,
        now_ms: u64,
    ) -> Result<MessageId, LedgerError> {
        if !self.draft.snapshot.has_content() {
            return Err(LedgerError::WrongStatus);
        }
        if self.find(&message).is_some() {
            return Err(LedgerError::DuplicateId);
        }
        let snapshot = std::mem::replace(&mut self.draft.snapshot, Snapshot::text(""));
        let source_generation = self.draft.generation.clone();
        self.submissions.push(Submission {
            id: message.clone(),
            scope: self.scope.clone(),
            source_generation,
            snapshot,
            status: Status::Queued,
            delivery,
            queued_for_turn: self.active_turn.clone(),
            attempt: None,
            attempts: 0,
            created_at_ms: now_ms,
            reason: None,
        });
        self.draft.generation = next_generation;
        self.draft.revision = 0;
        Ok(message)
    }

    /// Mark the next eligible queued message as sending and report a new attempt.
    ///
    /// `Uncertain` blocks the queue: the user must resolve it before more
    /// messages are dispatched, otherwise ordering becomes unprovable.
    pub fn begin_next(
        &mut self,
        attempt: AttemptId,
    ) -> Option<(MessageId, AttemptId, Delivery, Option<TurnId>)> {
        if self
            .submissions
            .iter()
            .any(|item| matches!(item.status, Status::Sending | Status::Uncertain))
        {
            return None;
        }
        let active = self.active_turn.clone();
        let index = self.submissions.iter().position(|item| {
            item.status == Status::Queued
                && match (&active, item.delivery) {
                    (None, _) => true,
                    (Some(turn), Delivery::Steer) => item.queued_for_turn.as_ref() == Some(turn),
                    (Some(_), Delivery::Start) => false,
                }
        })?;
        let item = &mut self.submissions[index];
        item.status = Status::Sending;
        item.attempt = Some(attempt.clone());
        item.reason = None;
        Some((item.id.clone(), attempt, item.delivery, active))
    }

    /// Settle one attempt. Results for a superseded attempt are ignored.
    pub fn settle(
        &mut self,
        id: &MessageId,
        attempt: Option<&AttemptId>,
        result: DeliveryResult,
    ) -> Result<Status, (LedgerError, Option<ReceiptError>)> {
        let (current_status, queued_for_turn) = {
            let item = self.find_mut(id).ok_or((LedgerError::NotFound, None))?;
            if matches!(item.status, Status::Cancelled | Status::Accepted) {
                return Err((LedgerError::WrongStatus, None));
            }
            if let Some(expected) = attempt {
                if item.attempt.as_ref() != Some(expected) {
                    return Err((LedgerError::StaleAttempt, None));
                }
            }
            (item.status, item.queued_for_turn.clone())
        };
        let result = match validate_result(id, &self.scope, result) {
            Ok(value) => value,
            Err(error) => {
                // A bad receipt is not an admission: keep the message uncertain.
                if current_status == Status::Rejected {
                    return Err((LedgerError::NoProgress, Some(error)));
                }
                let item = self.find_mut(id).ok_or((LedgerError::NotFound, None))?;
                item.status = Status::Uncertain;
                item.reason = Some(error.reason().to_string());
                return Ok(Status::Uncertain);
            }
        };
        match result {
            DeliveryResult::Accepted { receipt } => {
                let mut next_active = None;
                if !self.finished_turns.contains(&receipt.turn)
                    && (self.active_turn.is_none()
                        || self.active_turn.as_ref() == queued_for_turn.as_ref())
                {
                    next_active = Some(receipt.turn);
                }
                if let Some(turn) = next_active {
                    self.active_turn = Some(turn);
                }
                let item = self.find_mut(id).ok_or((LedgerError::NotFound, None))?;
                item.status = Status::Accepted;
                item.reason = None;
            }
            DeliveryResult::Rejected { reason } => {
                // A definitive rejection must not be weakened by a later lookup.
                if current_status == Status::Uncertain && reason.is_empty() {
                    return Err((LedgerError::NoProgress, None));
                }
                let item = self.find_mut(id).ok_or((LedgerError::NotFound, None))?;
                item.status = Status::Rejected;
                item.reason = Some(reason);
            }
            DeliveryResult::Uncertain { reason } => {
                if current_status == Status::Rejected {
                    return Err((LedgerError::NoProgress, None));
                }
                let item = self.find_mut(id).ok_or((LedgerError::NotFound, None))?;
                item.status = Status::Uncertain;
                item.reason = Some(reason);
            }
        }
        Ok(self
            .find(id)
            .map(|item| item.status)
            .unwrap_or(Status::Cancelled))
    }

    /// Turn began; recorded so late receipts cannot revive a finished turn.
    pub fn begin_turn(&mut self, turn: TurnId) -> bool {
        if turn.is_empty() || self.finished_turns.contains(&turn) {
            return false;
        }
        if let Some(active) = &self.active_turn {
            if active != &turn {
                return false;
            }
        }
        self.active_turn = Some(turn);
        true
    }

    /// Turn ended. Returns whether this turn was the active one.
    pub fn end_turn(&mut self, turn: &TurnId) -> bool {
        if self.finished_turns.contains(turn) {
            return false;
        }
        let was_active = self.active_turn.as_ref() == Some(turn);
        self.finished_turns.insert(turn.clone());
        if was_active {
            self.active_turn = None;
        }
        was_active
    }

    /// Requeue a definitively rejected message with its original identity.
    pub fn retry(&mut self, id: &MessageId) -> Result<(), LedgerError> {
        let active = self.active_turn.clone();
        let item = self.find_mut(id).ok_or(LedgerError::NotFound)?;
        if !item.status.is_retryable() {
            return Err(LedgerError::WrongStatus);
        }
        item.status = Status::Queued;
        item.attempt = None;
        item.delivery = Delivery::Start;
        item.queued_for_turn = active;
        item.reason = None;
        Ok(())
    }

    /// Take a rejected/queued payload back into an empty draft.
    ///
    /// Refuses when the draft is not exactly empty: an async restore must never
    /// overwrite what the user has typed since, and whitespace counts as typing.
    pub fn restore(
        &mut self,
        id: &MessageId,
        next_generation: GenerationId,
    ) -> Result<(), LedgerError> {
        if !self.draft.snapshot.is_empty() {
            return Err(LedgerError::WrongStatus);
        }
        let item = self.find(id).ok_or(LedgerError::NotFound)?;
        if !item.status.is_restorable() {
            return Err(LedgerError::WrongStatus);
        }
        let snapshot = item.snapshot.clone();
        let item = self.find_mut(id).expect("checked above");
        item.status = Status::Cancelled;
        item.reason = Some("已取回到独立草稿".to_string());
        self.draft.snapshot = snapshot;
        self.draft.generation = next_generation;
        self.draft.revision = 0;
        Ok(())
    }

    /// Delete a settled record. Unsettled payloads cannot be forgotten.
    pub fn remove(&mut self, id: &MessageId) -> Result<(), LedgerError> {
        let item = self.find(id).ok_or(LedgerError::NotFound)?;
        if !item.status.is_removable() {
            return Err(LedgerError::WrongStatus);
        }
        self.submissions.retain(|entry| &entry.id != id);
        self.pending_receipts.retain(|entry| &entry.id != id);
        Ok(())
    }

    /// Messages that block automatic dispatch until the user resolves them.
    pub fn blocking(&self) -> impl Iterator<Item = &Submission> {
        self.submissions
            .iter()
            .filter(|item| matches!(item.status, Status::Sending | Status::Uncertain))
    }

    pub fn queued(&self) -> impl Iterator<Item = &Submission> {
        self.submissions
            .iter()
            .filter(|item| item.status == Status::Queued)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCOPE: &str = "scope";
    fn scope() -> ScopeId {
        ScopeId::new(SCOPE)
    }
    fn gen(n: &str) -> GenerationId {
        GenerationId::new(n)
    }
    fn msg(n: &str) -> MessageId {
        MessageId::new(n)
    }
    fn attempt(n: &str) -> AttemptId {
        AttemptId::new(n)
    }
    fn accepted(id: &str, turn: &str) -> DeliveryResult {
        DeliveryResult::Accepted {
            receipt: crate::ids::Receipt {
                id: msg(id),
                scope: scope(),
                turn: TurnId::new(turn),
            },
        }
    }

    fn fresh() -> ScopeState {
        ScopeState::new(scope(), gen("g0"))
    }

    #[test]
    fn handoff_moves_payload_and_opens_new_generation() {
        let mut state = fresh();
        state.edit(Snapshot::text("A"));
        let id = state
            .handoff(msg("m1"), gen("g1"), Delivery::Start, 1)
            .unwrap();
        assert_eq!(id, msg("m1"));
        assert!(state.draft.snapshot.is_empty());
        assert_eq!(state.draft.generation, gen("g1"));
        assert_eq!(state.submissions[0].snapshot.text, "A");
    }

    #[test]
    fn handoff_refuses_empty_draft() {
        let mut state = fresh();
        assert_eq!(
            state.handoff(msg("m1"), gen("g1"), Delivery::Start, 1),
            Err(LedgerError::WrongStatus)
        );
    }

    #[test]
    fn attachment_only_draft_is_submittable() {
        let mut state = fresh();
        state.edit(Snapshot {
            text: String::new(),
            attachment_ids: vec!["f".into()],
            reference_ids: vec![],
        });
        assert!(state
            .handoff(msg("m1"), gen("g1"), Delivery::Start, 1)
            .is_ok());
    }

    #[test]
    fn new_draft_edit_survives_late_acceptance() {
        let mut state = fresh();
        state.edit(Snapshot::text("A"));
        state
            .handoff(msg("m1"), gen("g1"), Delivery::Start, 1)
            .unwrap();
        let (id, att, _, _) = state.begin_next(attempt("a1")).unwrap();
        state.edit(Snapshot::text("B"));
        state
            .settle(&id, Some(&att), accepted("m1", "turn-1"))
            .unwrap();
        assert_eq!(state.draft.snapshot.text, "B");
        assert_eq!(state.submissions[0].status, Status::Accepted);
    }

    #[test]
    fn stale_attempt_cannot_settle() {
        let mut state = fresh();
        state.edit(Snapshot::text("A"));
        state
            .handoff(msg("m1"), gen("g1"), Delivery::Start, 1)
            .unwrap();
        let (id, _, _, _) = state.begin_next(attempt("a1")).unwrap();
        let result = state.settle(&id, Some(&attempt("a0")), accepted("m1", "turn-1"));
        assert_eq!(result, Err((LedgerError::StaleAttempt, None)));
    }

    #[test]
    fn cross_scope_receipt_becomes_uncertain_not_accepted() {
        let mut state = fresh();
        state.edit(Snapshot::text("A"));
        state
            .handoff(msg("m1"), gen("g1"), Delivery::Start, 1)
            .unwrap();
        let (id, att, _, _) = state.begin_next(attempt("a1")).unwrap();
        let bad = DeliveryResult::Accepted {
            receipt: crate::ids::Receipt {
                id: msg("m1"),
                scope: ScopeId::new("other"),
                turn: TurnId::new("turn-1"),
            },
        };
        assert_eq!(state.settle(&id, Some(&att), bad), Ok(Status::Uncertain));
        assert!(state.active_turn.is_none());
    }

    #[test]
    fn uncertain_blocks_queue_and_forbids_retry_restore_remove() {
        let mut state = fresh();
        state.edit(Snapshot::text("A"));
        state
            .handoff(msg("m1"), gen("g1"), Delivery::Start, 1)
            .unwrap();
        let (id, att, _, _) = state.begin_next(attempt("a1")).unwrap();
        state
            .settle(
                &id,
                Some(&att),
                DeliveryResult::Uncertain {
                    reason: "lost".into(),
                },
            )
            .unwrap();
        state.edit(Snapshot::text("B"));
        state
            .handoff(msg("m2"), gen("g2"), Delivery::Start, 2)
            .unwrap();
        // An unsettled payload blocks further automatic dispatch.
        assert!(state.begin_next(attempt("a2")).is_none());
        assert_eq!(state.retry(&id), Err(LedgerError::WrongStatus));
        assert_eq!(state.restore(&id, gen("g3")), Err(LedgerError::WrongStatus));
        assert_eq!(state.remove(&id), Err(LedgerError::WrongStatus));
    }

    #[test]
    fn definitive_rejection_is_not_weakened_by_later_uncertain() {
        let mut state = fresh();
        state.edit(Snapshot::text("A"));
        state
            .handoff(msg("m1"), gen("g1"), Delivery::Start, 1)
            .unwrap();
        let (id, att, _, _) = state.begin_next(attempt("a1")).unwrap();
        state
            .settle(
                &id,
                Some(&att),
                DeliveryResult::Rejected {
                    reason: "no".into(),
                },
            )
            .unwrap();
        let result = state.settle(
            &id,
            Some(&att),
            DeliveryResult::Uncertain {
                reason: "stale".into(),
            },
        );
        assert_eq!(result, Err((LedgerError::NoProgress, None)));
        assert_eq!(state.submissions[0].status, Status::Rejected);
    }

    #[test]
    fn restore_refuses_non_empty_draft_including_whitespace() {
        let mut state = fresh();
        state.edit(Snapshot::text("A"));
        state
            .handoff(msg("m1"), gen("g1"), Delivery::Start, 1)
            .unwrap();
        let (id, att, _, _) = state.begin_next(attempt("a1")).unwrap();
        state
            .settle(
                &id,
                Some(&att),
                DeliveryResult::Rejected {
                    reason: "no".into(),
                },
            )
            .unwrap();
        state.edit(Snapshot::text(" \n"));
        assert_eq!(state.restore(&id, gen("g2")), Err(LedgerError::WrongStatus));
        state.edit(Snapshot::text(""));
        assert!(state.restore(&id, gen("g2")).is_ok());
        assert_eq!(state.draft.snapshot.text, "A");
        assert_eq!(state.submissions[0].status, Status::Cancelled);
    }

    #[test]
    fn finished_turn_is_not_revived_by_late_acceptance() {
        let mut state = fresh();
        state.edit(Snapshot::text("A"));
        state
            .handoff(msg("m1"), gen("g1"), Delivery::Start, 1)
            .unwrap();
        let (id, att, _, _) = state.begin_next(attempt("a1")).unwrap();
        state.begin_turn(TurnId::new("turn-1"));
        assert!(state.end_turn(&TurnId::new("turn-1")));
        state
            .settle(&id, Some(&att), accepted("m1", "turn-1"))
            .unwrap();
        assert_eq!(state.submissions[0].status, Status::Accepted);
        assert!(state.active_turn.is_none());
    }

    #[test]
    fn queued_messages_advance_one_per_finished_turn() {
        let mut state = fresh();
        for (i, text) in ["A", "B", "C"].iter().enumerate() {
            state.edit(Snapshot::text(*text));
            let generation = format!("g{}", i + 1);
            state
                .handoff(
                    msg(&format!("m{i}")),
                    gen(&generation),
                    Delivery::Start,
                    i as u64,
                )
                .unwrap();
        }
        let (first, a1, _, _) = state.begin_next(attempt("a1")).unwrap();
        assert_eq!(first, msg("m0"));
        state
            .settle(&first, Some(&a1), accepted("m0", "turn-1"))
            .unwrap();
        // A turn is active, so plain starts wait for it to end.
        assert!(state.begin_next(attempt("a2")).is_none());
        assert!(state.end_turn(&TurnId::new("turn-1")));
        let (second, a2, _, _) = state.begin_next(attempt("a3")).unwrap();
        assert_eq!(second, msg("m1"));
        state
            .settle(&second, Some(&a2), accepted("m1", "turn-2"))
            .unwrap();
        assert!(state.end_turn(&TurnId::new("turn-2")));
        let (third, _, _, _) = state.begin_next(attempt("a4")).unwrap();
        assert_eq!(third, msg("m2"));
    }

    #[test]
    fn steer_targets_the_active_turn_only() {
        let mut state = fresh();
        state.begin_turn(TurnId::new("turn-1"));
        state.edit(Snapshot::text("S"));
        state
            .handoff(msg("m1"), gen("g1"), Delivery::Steer, 1)
            .unwrap();
        let (_, _, delivery, turn) = state.begin_next(attempt("a1")).unwrap();
        assert_eq!(delivery, Delivery::Steer);
        assert_eq!(turn, Some(TurnId::new("turn-1")));
    }

    #[test]
    fn duplicate_message_id_is_refused() {
        let mut state = fresh();
        state.edit(Snapshot::text("A"));
        state
            .handoff(msg("m1"), gen("g1"), Delivery::Start, 1)
            .unwrap();
        state.edit(Snapshot::text("B"));
        assert_eq!(
            state.handoff(msg("m1"), gen("g2"), Delivery::Start, 2),
            Err(LedgerError::DuplicateId)
        );
    }
}
