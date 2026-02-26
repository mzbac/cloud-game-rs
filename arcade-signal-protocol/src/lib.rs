use serde::{Deserialize, Serialize};

pub mod ids {
    pub const GAMES: &str = "games";
    pub const GET_GAMES: &str = "getGames";
    pub const UPDATE: &str = "update";

    pub const INIT_WEBRTC: &str = "initwebrtc";
    pub const OFFER: &str = "offer";
    pub const ANSWER: &str = "answer";
    pub const CANDIDATE: &str = "candidate";
    pub const JOIN_ROOM: &str = "joinRoom";
    pub const TERMINATE_SESSION: &str = "terminateSession";
    pub const INPUT: &str = "input";

    pub const GAME_INFO: &str = "gameInfo";
    pub const UPDATE_PLAYER_COUNT: &str = "updatePlayerCount";

    pub const CONTROLLER_HOST: &str = "controllerHost";
    pub const CONTROLLER_READY: &str = "controllerReady";
    pub const CONTROLLER_JOIN: &str = "controllerJoin";
    pub const CONTROLLER_JOINED: &str = "controllerJoined";
    pub const CONTROLLER_LEFT: &str = "controllerLeft";
    pub const CONTROLLER_REJECTED: &str = "controllerRejected";
    pub const CONTROLLER_INPUT: &str = "controllerInput";
    pub const CONTROLLER_AUDIO: &str = "controllerAudio";
}

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
