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
    #[serde(rename = "sessionID", default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl SignalMessage {
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
}
