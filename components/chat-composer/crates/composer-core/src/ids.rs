//! Strongly typed identities and delivery states for the reliable composer.
//!
//! The point of the newtypes is that the compiler refuses to let an attempt ID
//! stand in for a message ID, or a turn ID for a receipt ID. In the TypeScript
//! implementation that discipline was held by tests; here it is a type error.

use serde::{Deserialize, Serialize};

/// Identifies one logical user message. Stable across retries; survives restarts.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct MessageId(String);

/// Identifies one attempt to deliver a message. A retry gets a new attempt ID.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AttemptId(String);

/// Identifies one draft generation. A handoff always allocates a new one.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct GenerationId(String);

/// Identifies one agent turn reported by the host.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct TurnId(String);

/// Identifies the conversation scope that owns a draft and its outbox.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ScopeId(String);

macro_rules! id_type {
    ($($name:ident),+ $(,)?) => {
        $(
            impl $name {
                pub fn new(value: impl Into<String>) -> Self {
                    $name(value.into())
                }
                pub fn as_str(&self) -> &str {
                    &self.0
                }
                pub fn is_empty(&self) -> bool {
                    self.0.trim().is_empty()
                }
            }
            impl std::fmt::Display for $name {
                fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    f.write_str(&self.0)
                }
            }
        )+
    };
}

id_type!(MessageId, AttemptId, GenerationId, TurnId, ScopeId);

/// Lifecycle of one message in the durable outbox.
///
/// `Uncertain` is the only state that forbids automatic follow-up: it means the
/// host may or may not have admitted the message, so the composer must not
/// resend it and must not restore it into an editable draft.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Sending,
    Accepted,
    Rejected,
    Uncertain,
    Cancelled,
}

impl Status {
    /// Whether the payload must stay in the outbox (never silently dropped).
    pub fn is_payload_owned(self) -> bool {
        matches!(self, Status::Queued | Status::Sending | Status::Uncertain)
    }

    /// Whether the user may retry this message with the same identity.
    pub fn is_retryable(self) -> bool {
        matches!(self, Status::Rejected)
    }

    /// Whether the payload may be restored into an editable draft.
    pub fn is_restorable(self) -> bool {
        matches!(self, Status::Rejected | Status::Queued)
    }

    /// Whether the user may delete this record and its local payload copy.
    pub fn is_removable(self) -> bool {
        matches!(
            self,
            Status::Accepted | Status::Rejected | Status::Cancelled
        )
    }
}

/// How an accepted message relates to the agent's turn lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    Start,
    Steer,
}

/// What the host is allowed to tell the composer about one submission.
///
/// There is deliberately no `Failed` variant: a transport error is not proof of
/// non-admission, and a missing receipt must stay `Uncertain`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum DeliveryResult {
    Accepted { receipt: Receipt },
    Rejected { reason: String },
    Uncertain { reason: String },
}

/// The host's proof that a specific message was durably admitted by a turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt {
    pub id: MessageId,
    pub scope: ScopeId,
    pub turn: TurnId,
}

/// Outcome of validating a host response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReceiptError {
    /// The host answered with something that is not a delivery result.
    Malformed,
    /// The receipt names a different message, scope, or an empty turn.
    IdentityMismatch,
}

impl ReceiptError {
    pub fn reason(&self) -> &'static str {
        match self {
            ReceiptError::Malformed => "宿主返回了无效的送达结果",
            ReceiptError::IdentityMismatch => "回执的消息、会话或轮次身份不匹配",
        }
    }
}

/// A host response is only trustworthy when it names exactly this submission.
pub fn validate_result(
    expected_message: &MessageId,
    expected_scope: &ScopeId,
    result: DeliveryResult,
) -> Result<DeliveryResult, ReceiptError> {
    match result {
        DeliveryResult::Accepted { receipt } => {
            if &receipt.id != expected_message
                || &receipt.scope != expected_scope
                || receipt.turn.is_empty()
            {
                Err(ReceiptError::IdentityMismatch)
            } else {
                Ok(DeliveryResult::Accepted { receipt })
            }
        }
        other => Ok(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(message: &str, scope: &str, turn: &str) -> DeliveryResult {
        DeliveryResult::Accepted {
            receipt: Receipt {
                id: MessageId::new(message),
                scope: ScopeId::new(scope),
                turn: TurnId::new(turn),
            },
        }
    }

    #[test]
    fn matching_receipt_is_accepted() {
        let result = validate_result(
            &MessageId::new("m1"),
            &ScopeId::new("scope"),
            receipt("m1", "scope", "turn-1"),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn cross_scope_receipt_is_rejected_as_mismatch() {
        let result = validate_result(
            &MessageId::new("m1"),
            &ScopeId::new("scope"),
            receipt("m1", "other", "turn-1"),
        );
        assert_eq!(result, Err(ReceiptError::IdentityMismatch));
    }

    #[test]
    fn foreign_message_id_is_mismatch() {
        let result = validate_result(
            &MessageId::new("m1"),
            &ScopeId::new("scope"),
            receipt("m2", "scope", "turn-1"),
        );
        assert_eq!(result, Err(ReceiptError::IdentityMismatch));
    }

    #[test]
    fn empty_turn_identity_is_mismatch() {
        let result = validate_result(
            &MessageId::new("m1"),
            &ScopeId::new("scope"),
            receipt("m1", "scope", "   "),
        );
        assert_eq!(result, Err(ReceiptError::IdentityMismatch));
    }

    #[test]
    fn unclear_states_own_their_payload_and_are_not_retryable() {
        assert!(Status::Uncertain.is_payload_owned());
        assert!(!Status::Uncertain.is_retryable());
        assert!(!Status::Uncertain.is_restorable());
        assert!(!Status::Uncertain.is_removable());
        assert!(Status::Rejected.is_retryable());
        assert!(Status::Queued.is_restorable());
        assert!(Status::Accepted.is_removable());
    }
}
