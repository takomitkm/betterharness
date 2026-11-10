//! wasm-bindgen surface for the reliable composer core.
//!
//! Boundary decision: attachment bytes never cross into WASM. Rust owns the
//! ledger and its *references* to attachments; the host's store owns the actual
//! bytes. This keeps the hot path allocation-free and avoids serialising Blobs
//! through wasm-bindgen, while preserving the ownership rule that a payload's
//! attachment IDs travel with the message until it is settled.

use crate::ids::{AttemptId, Delivery, DeliveryResult, GenerationId, MessageId, ScopeId, Status, TurnId};
use crate::state::{LedgerError, ScopeState, Snapshot};
use wasm_bindgen::prelude::*;

/// Convert an internal error into a stable machine-readable code for JS.
fn code(error: LedgerError) -> &'static str {
    match error {
        LedgerError::NotFound => "not_found",
        LedgerError::WrongStatus => "wrong_status",
        LedgerError::StaleAttempt => "stale_attempt",
        LedgerError::NoProgress => "no_progress",
        LedgerError::DuplicateId => "duplicate_id",
    }
}

/// Owned composer state exposed to JavaScript. The exported handle is the only
/// way to mutate it, so a stale JS reference cannot reach a settled payload.
#[wasm_bindgen]
pub struct ComposerCore {
    state: ScopeState,
}

#[wasm_bindgen]
impl ComposerCore {
    /// Create the empty state for one scope.
    #[wasm_bindgen(constructor)]
    pub fn new(scope: &str, generation: &str) -> ComposerCore {
        ComposerCore {
            state: ScopeState::new(ScopeId::new(scope), GenerationId::new(generation)),
        }
    }

    /// Restore from a persisted JSON snapshot produced by `to_json`.
    #[wasm_bindgen(js_name = fromJson)]
    pub fn from_json(json: &str) -> Result<ComposerCore, JsValue> {
        let state: ScopeState = serde_json::from_str(json)
            .map_err(|error| JsValue::from_str(&format!("corrupt composer state: {error}")))?;
        if state.schema != 1 {
            return Err(JsValue::from_str("unsupported composer schema; existing data was not overwritten"));
        }
        Ok(ComposerCore { state })
    }

    /// Serialise the complete state, including the outbox, for one atomic write.
    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.state).map_err(|error| JsValue::from_str(&error.to_string()))
    }

    /// Persisted revision, used by the host for compare-and-swap.
    #[wasm_bindgen(getter)]
    pub fn revision(&self) -> f64 {
        self.state.revision as f64
    }

    #[wasm_bindgen(getter, js_name = draftText)]
    pub fn draft_text(&self) -> String {
        self.state.draft.snapshot.text.clone()
    }

    #[wasm_bindgen(getter, js_name = draftGeneration)]
    pub fn draft_generation(&self) -> String {
        self.state.draft.generation.to_string()
    }

    #[wasm_bindgen(getter, js_name = draftRevision)]
    pub fn draft_revision(&self) -> f64 {
        self.state.draft.revision as f64
    }

    /// Replace the draft content. `attachment_ids` are JSON array strings.
    pub fn edit(&mut self, text: &str, attachment_ids: &str, reference_ids: &str) -> Result<(), JsValue> {
        let attachments: Vec<String> = serde_json::from_str(attachment_ids)
            .map_err(|error| JsValue::from_str(&format!("invalid attachment ids: {error}")))?;
        let references: Vec<String> = serde_json::from_str(reference_ids)
            .map_err(|error| JsValue::from_str(&format!("invalid reference ids: {error}")))?;
        self.state.edit(Snapshot { text: text.to_string(), attachment_ids: attachments, reference_ids: references });
        Ok(())
    }

    /// Move the draft into the outbox. Returns the message ID, or an error code.
    #[wasm_bindgen(js_name = handoff)]
    pub fn handoff_js(&mut self, message: &str, next_generation: &str, steer: bool, now_ms: f64) -> Result<String, JsValue> {
        let delivery = if steer { Delivery::Steer } else { Delivery::Start };
        self.state
            .handoff(
                MessageId::new(message),
                GenerationId::new(next_generation),
                delivery,
                now_ms as u64,
            )
            .map(|id| id.to_string())
            .map_err(|error| JsValue::from_str(code(error)))
    }

    /// Start the next eligible queued message. Returns `{}` when nothing may start.
    #[wasm_bindgen(js_name = beginNext)]
    pub fn begin_next_js(&mut self, attempt: &str) -> Result<JsValue, JsValue> {
        match self.state.begin_next(AttemptId::new(attempt)) {
            None => Ok(JsValue::NULL),
            Some((id, attempt, delivery, turn)) => {
                let payload = serde_json::json!({
                    "id": id.to_string(),
                    "attempt": attempt.to_string(),
                    "delivery": match delivery { Delivery::Start => "start", Delivery::Steer => "steer" },
                    "turnId": turn.map(|turn| turn.to_string()),
                });
                Ok(JsValue::from_str(&payload.to_string()))
            }
        }
    }

    /// Settle one attempt with a host result. Returns the resulting status string.
    #[wasm_bindgen(js_name = settle)]
    pub fn settle_js(&mut self, id: &str, attempt: &str, result_json: &str) -> Result<String, JsValue> {
        let result: DeliveryResult = serde_json::from_str(result_json)
            .map_err(|error| JsValue::from_str(&format!("invalid delivery result: {error}")))?;
        let attempt = if attempt.is_empty() { None } else { Some(AttemptId::new(attempt)) };
        match self.state.settle(&MessageId::new(id), attempt.as_ref(), result) {
            Ok(status) => Ok(status_str(status).to_string()),
            Err((error, _)) => Err(JsValue::from_str(code(error))),
        }
    }

    #[wasm_bindgen(js_name = beginTurn)]
    pub fn begin_turn_js(&mut self, turn: &str) -> bool {
        self.state.begin_turn(TurnId::new(turn))
    }

    #[wasm_bindgen(js_name = endTurn)]
    pub fn end_turn_js(&mut self, turn: &str) -> bool {
        self.state.end_turn(&TurnId::new(turn))
    }

    pub fn retry(&mut self, id: &str) -> Result<(), JsValue> {
        self.state.retry(&MessageId::new(id)).map_err(|error| JsValue::from_str(code(error)))
    }

    pub fn restore(&mut self, id: &str, next_generation: &str) -> Result<(), JsValue> {
        self.state
            .restore(&MessageId::new(id), GenerationId::new(next_generation))
            .map_err(|error| JsValue::from_str(code(error)))
    }

    pub fn remove(&mut self, id: &str) -> Result<(), JsValue> {
        self.state.remove(&MessageId::new(id)).map_err(|error| JsValue::from_str(code(error)))
    }

    /// Snapshot of the outbox for rendering: JSON array of records.
    #[wasm_bindgen(js_name = submissionsJson)]
    pub fn submissions_json(&self) -> String {
        serde_json::json!(self.state.submissions.iter().map(|item| serde_json::json!({
            "id": item.id.to_string(),
            "status": status_str(item.status),
            "text": item.snapshot.text,
            "attachments": item.snapshot.attachment_ids,
            "references": item.snapshot.reference_ids,
            "attempt": item.attempt.as_ref().map(|value| value.to_string()),
            "reason": item.reason,
        })).collect::<Vec<_>>())
        .to_string()
    }

    /// Whether automatic dispatch must pause (sending or uncertain records exist).
    #[wasm_bindgen(js_name = hasBlocking)]
    pub fn has_blocking(&self) -> bool {
        self.state.blocking().next().is_some()
    }
}

fn status_str(status: Status) -> &'static str {
    match status {
        Status::Queued => "queued",
        Status::Sending => "sending",
        Status::Accepted => "accepted",
        Status::Rejected => "rejected",
        Status::Uncertain => "uncertain",
        Status::Cancelled => "cancelled",
    }
}
