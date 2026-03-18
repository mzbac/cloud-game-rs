use serde::{Deserialize, Serialize};

pub mod ids;
pub mod audio;
pub mod rtc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalMessage {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// Routing target identifier.
    ///
    /// Historical note: this is serialized as `sessionID` for backwards compatibility with older
    /// clients. It is not a stable "session id" concept.
    #[serde(rename = "sessionID", default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl SignalMessage {
    pub fn target_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn with_payload(
        id: impl Into<String>,
        session_id: Option<String>,
        data: Option<String>,
    ) -> Self {
        Self {
            id: id.into(),
            data,
            session_id,
        }
    }

    pub fn with_target(id: impl Into<String>, target_id: Option<String>, data: Option<String>) -> Self {
        Self {
            id: id.into(),
            data,
            session_id: target_id,
        }
    }
}
