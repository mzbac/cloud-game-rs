use std::error::Error;
use std::fmt::{self, Display, Formatter};

use arcade_signal_protocol::{ids as signal_ids, SignalMessage};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

#[derive(Debug)]
pub enum OutboundEvent {
    Message(SignalMessage),
    Close,
}

pub type Tx = mpsc::UnboundedSender<OutboundEvent>;

#[derive(Debug, Clone, Copy)]
pub enum WorkerEventKind {
    InitWebrtc,
    Answer,
    Candidate,
    JoinRoom,
    Input,
}

impl WorkerEventKind {
    fn signal_id(self) -> &'static str {
        match self {
            Self::InitWebrtc => signal_ids::INIT_WEBRTC,
            Self::Answer => signal_ids::ANSWER,
            Self::Candidate => signal_ids::CANDIDATE,
            Self::JoinRoom => signal_ids::JOIN_ROOM,
            Self::Input => signal_ids::INPUT,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ClientEventKind {
    Offer,
    Candidate,
}

impl ClientEventKind {
    fn signal_id(self) -> &'static str {
        match self {
            Self::Offer => signal_ids::OFFER,
            Self::Candidate => signal_ids::CANDIDATE,
        }
    }
}

#[derive(Debug)]
pub enum BrowserCommand {
    RequestGames,
    ForwardToWorker {
        worker_id: String,
        event: WorkerEventKind,
        data: Option<String>,
        bind_client: bool,
    },
    TerminateSession {
        worker_id: Option<String>,
    },
    ControllerHost {
        worker_id: String,
    },
    ControllerJoin {
        code: String,
    },
    ControllerInput {
        host_client_id: String,
        data: String,
    },
    ControllerAudio {
        host_client_id: String,
        action: String,
    },
}

#[derive(Debug)]
pub enum WorkerCommand {
    GameInfo {
        game_name: Option<String>,
    },
    ForwardToClient {
        client_id: String,
        event: ClientEventKind,
        data: Option<String>,
    },
    UpdatePlayerCount {
        count: usize,
    },
}

#[derive(Debug)]
pub enum ProtocolError {
    InvalidJson {
        reason: String,
    },
    InvalidEnvelope,
    InvalidPayload {
        id: String,
        reason: String,
    },
    UnknownBrowserMessage {
        id: String,
    },
    UnknownWorkerMessage {
        id: String,
    },
    MissingTarget {
        id: String,
    },
    MissingPayload {
        id: String,
    },
    InvalidPlayerCount {
        raw: Option<String>,
    },
}

impl Display for ProtocolError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson { reason } => write!(f, "invalid json payload: {reason}"),
            Self::InvalidEnvelope => write!(f, "invalid signaling message envelope"),
            Self::InvalidPayload { id, reason } => {
                write!(f, "invalid payload for message '{id}': {reason}")
            }
            Self::UnknownBrowserMessage { id } => write!(f, "unknown browser message id '{id}'"),
            Self::UnknownWorkerMessage { id } => write!(f, "unknown worker message id '{id}'"),
            Self::MissingTarget { id } => write!(f, "missing target for message '{id}'"),
            Self::MissingPayload { id } => write!(f, "missing payload for message '{id}'"),
            Self::InvalidPlayerCount { raw } => {
                write!(f, "invalid player count payload '{:?}'", raw)
            }
        }
    }
}

impl Error for ProtocolError {}

pub fn parse_browser_message_text(text: &str) -> Result<SignalMessage, ProtocolError> {
    parse_message_text(text)
}

pub fn parse_worker_message_text(text: &str) -> Result<SignalMessage, ProtocolError> {
    parse_message_text(text)
}

pub fn parse_browser_command(req: SignalMessage) -> Result<BrowserCommand, ProtocolError> {
    let SignalMessage {
        id,
        data,
        session_id: target_id,
    } = req;

    match id.as_str() {
        signal_ids::GET_GAMES => Ok(BrowserCommand::RequestGames),
        signal_ids::INIT_WEBRTC => Ok(BrowserCommand::ForwardToWorker {
            worker_id: required_target(&id, target_id)?,
            event: WorkerEventKind::InitWebrtc,
            data,
            bind_client: true,
        }),
        signal_ids::ANSWER => Ok(BrowserCommand::ForwardToWorker {
            worker_id: required_target(&id, target_id)?,
            event: WorkerEventKind::Answer,
            data,
            bind_client: false,
        }),
        signal_ids::CANDIDATE => Ok(BrowserCommand::ForwardToWorker {
            worker_id: required_target(&id, target_id)?,
            event: WorkerEventKind::Candidate,
            data,
            bind_client: false,
        }),
        signal_ids::JOIN_ROOM => Ok(BrowserCommand::ForwardToWorker {
            worker_id: required_target(&id, target_id)?,
            event: WorkerEventKind::JoinRoom,
            data,
            bind_client: true,
        }),
        signal_ids::INPUT => Ok(BrowserCommand::ForwardToWorker {
            worker_id: required_target(&id, target_id)?,
            event: WorkerEventKind::Input,
            data,
            bind_client: false,
        }),
        signal_ids::TERMINATE_SESSION => Ok(BrowserCommand::TerminateSession {
            worker_id: optional_target(target_id),
        }),
        signal_ids::CONTROLLER_HOST => Ok(BrowserCommand::ControllerHost {
            worker_id: required_target(&id, target_id)?,
        }),
        signal_ids::CONTROLLER_JOIN => Ok(BrowserCommand::ControllerJoin {
            code: required_payload(&id, data)?,
        }),
        signal_ids::CONTROLLER_INPUT => Ok(BrowserCommand::ControllerInput {
            host_client_id: required_target(&id, target_id)?,
            data: required_payload(&id, data)?,
        }),
        signal_ids::CONTROLLER_AUDIO => Ok(BrowserCommand::ControllerAudio {
            host_client_id: required_target(&id, target_id)?,
            action: required_payload(&id, data)?,
        }),
        _ => Err(ProtocolError::UnknownBrowserMessage { id }),
    }
}

pub fn parse_worker_command(req: SignalMessage) -> Result<WorkerCommand, ProtocolError> {
    let SignalMessage {
        id,
        data,
        session_id: target_id,
    } = req;

    match id.as_str() {
        signal_ids::GAME_INFO => Ok(WorkerCommand::GameInfo { game_name: data }),
        signal_ids::OFFER => Ok(WorkerCommand::ForwardToClient {
            client_id: required_target(&id, target_id)?,
            event: ClientEventKind::Offer,
            data,
        }),
        signal_ids::CANDIDATE => Ok(WorkerCommand::ForwardToClient {
            client_id: required_target(&id, target_id)?,
            event: ClientEventKind::Candidate,
            data,
        }),
        signal_ids::UPDATE_PLAYER_COUNT => {
            let count = data
                .as_deref()
                .map(str::trim)
                .ok_or_else(|| ProtocolError::InvalidPlayerCount { raw: data.clone() })?
                .parse::<usize>()
                .map_err(|_| ProtocolError::InvalidPlayerCount { raw: data.clone() })?;
            Ok(WorkerCommand::UpdatePlayerCount { count })
        }
        _ => Err(ProtocolError::UnknownWorkerMessage { id }),
    }
}

pub fn games_message(payload: String) -> SignalMessage {
    SignalMessage {
        id: signal_ids::GAMES.to_string(),
        data: Some(payload),
        session_id: None,
    }
}

pub fn terminate_session_message(client_id: &str) -> SignalMessage {
    SignalMessage {
        id: signal_ids::TERMINATE_SESSION.to_string(),
        data: None,
        session_id: Some(client_id.to_string()),
    }
}

pub fn forward_to_worker_message(
    event: WorkerEventKind,
    client_id: String,
    data: Option<String>,
) -> SignalMessage {
    SignalMessage {
        id: event.signal_id().to_string(),
        data,
        session_id: Some(client_id),
    }
}

pub fn forward_to_client_message(
    event: ClientEventKind,
    client_id: String,
    data: Option<String>,
) -> SignalMessage {
    SignalMessage {
        id: event.signal_id().to_string(),
        data,
        session_id: Some(client_id),
    }
}

pub fn update_player_count_message(worker_id: String, count: usize) -> SignalMessage {
    SignalMessage {
        id: signal_ids::UPDATE_PLAYER_COUNT.to_string(),
        data: Some(count.to_string()),
        session_id: Some(worker_id),
    }
}

pub fn controller_ready_message(payload: String) -> SignalMessage {
    SignalMessage {
        id: signal_ids::CONTROLLER_READY.to_string(),
        data: Some(payload),
        session_id: None,
    }
}

pub fn controller_joined_message(peer_client_id: String) -> SignalMessage {
    SignalMessage {
        id: signal_ids::CONTROLLER_JOINED.to_string(),
        data: None,
        session_id: Some(peer_client_id),
    }
}

pub fn controller_left_message(peer_client_id: String) -> SignalMessage {
    SignalMessage {
        id: signal_ids::CONTROLLER_LEFT.to_string(),
        data: None,
        session_id: Some(peer_client_id),
    }
}

pub fn controller_rejected_message(reason: &str) -> SignalMessage {
    SignalMessage {
        id: signal_ids::CONTROLLER_REJECTED.to_string(),
        data: Some(reason.to_string()),
        session_id: None,
    }
}

pub fn controller_audio_message(controller_client_id: String, action: String) -> SignalMessage {
    SignalMessage {
        id: signal_ids::CONTROLLER_AUDIO.to_string(),
        data: Some(action),
        session_id: Some(controller_client_id),
    }
}

fn parse_message_text(text: &str) -> Result<SignalMessage, ProtocolError> {
    let value =
        serde_json::from_str::<Value>(text).map_err(|err| ProtocolError::InvalidJson {
            reason: err.to_string(),
        })?;
    let object = value.as_object().ok_or(ProtocolError::InvalidEnvelope)?;

    let id = required_json_string(object, "id")
        .ok_or(ProtocolError::InvalidEnvelope)?
        .to_string();
    let data = canonicalize_payload(&id, optional_json_string(object, "data"))?;
    let session_id =
        optional_json_string(object, "sessionID").or_else(|| optional_json_string(object, "session_id"));

    Ok(SignalMessage { id, data, session_id })
}

fn required_target(id: &str, session_id: Option<String>) -> Result<String, ProtocolError> {
    optional_target(session_id).ok_or_else(|| ProtocolError::MissingTarget { id: id.to_string() })
}

fn required_payload(id: &str, payload: Option<String>) -> Result<String, ProtocolError> {
    optional_payload(payload).ok_or_else(|| ProtocolError::MissingPayload { id: id.to_string() })
}

fn optional_target(session_id: Option<String>) -> Option<String> {
    session_id.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then_some(trimmed.to_string())
    })
}

fn optional_payload(payload: Option<String>) -> Option<String> {
    payload.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then_some(trimmed.to_string())
    })
}

fn required_json_string<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn optional_json_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    required_json_string(object, key).map(ToOwned::to_owned)
}

fn canonicalize_payload(id: &str, payload: Option<String>) -> Result<Option<String>, ProtocolError> {
    let Some(payload) = payload else {
        return Ok(None);
    };

    let canonical = match id {
        signal_ids::OFFER => canonicalize_session_description_payload(id, &payload)?,
        signal_ids::ANSWER => canonicalize_session_description_payload(id, &payload)?,
        signal_ids::CANDIDATE => canonicalize_candidate_payload(id, &payload)?,
        _ => payload,
    };

    Ok(Some(canonical))
}

fn canonicalize_session_description_payload(id: &str, payload: &str) -> Result<String, ProtocolError> {
    let expected_type = match id {
        signal_ids::OFFER => "offer",
        signal_ids::ANSWER => "answer",
        _ => {
            return Err(ProtocolError::InvalidPayload {
                id: id.to_string(),
                reason: "unsupported session description message".to_string(),
            });
        }
    };

    let raw = decode_payload_or_raw(payload);
    let normalized = match serde_json::from_slice::<Value>(&raw) {
        Ok(Value::Object(mut obj)) => {
            if !obj.contains_key("type") {
                obj.insert("type".to_string(), Value::String(expected_type.to_string()));
            }
            Value::Object(obj)
        }
        Ok(Value::String(sdp)) => json!({
            "type": expected_type,
            "sdp": sdp,
        }),
        Ok(other) => {
            return Err(ProtocolError::InvalidPayload {
                id: id.to_string(),
                reason: format!("expected session description object or string, got {other}"),
            });
        }
        Err(_) => {
            let sdp = String::from_utf8(raw).map_err(|err| ProtocolError::InvalidPayload {
                id: id.to_string(),
                reason: format!("payload is neither base64 json nor utf8 sdp: {err}"),
            })?;
            json!({
                "type": expected_type,
                "sdp": sdp,
            })
        }
    };

    let json_bytes = serde_json::to_vec(&normalized).map_err(|err| ProtocolError::InvalidPayload {
        id: id.to_string(),
        reason: format!("failed to serialize normalized session description: {err}"),
    })?;
    Ok(BASE64_STANDARD.encode(json_bytes))
}

fn canonicalize_candidate_payload(id: &str, payload: &str) -> Result<String, ProtocolError> {
    let raw = decode_payload_or_raw(payload);
    let normalized = match serde_json::from_slice::<Value>(&raw) {
        Ok(Value::Object(obj)) => Value::Object(obj),
        Ok(Value::String(candidate)) => json!({
            "candidate": candidate,
        }),
        Ok(other) => {
            return Err(ProtocolError::InvalidPayload {
                id: id.to_string(),
                reason: format!("expected candidate object or string, got {other}"),
            });
        }
        Err(_) => {
            let candidate = String::from_utf8(raw).map_err(|err| ProtocolError::InvalidPayload {
                id: id.to_string(),
                reason: format!("payload is neither base64 json nor utf8 candidate: {err}"),
            })?;
            json!({
                "candidate": candidate,
            })
        }
    };

    let json_bytes = serde_json::to_vec(&normalized).map_err(|err| ProtocolError::InvalidPayload {
        id: id.to_string(),
        reason: format!("failed to serialize normalized candidate: {err}"),
    })?;
    Ok(BASE64_STANDARD.encode(json_bytes))
}

fn decode_payload_or_raw(payload: &str) -> Vec<u8> {
    BASE64_STANDARD
        .decode(payload)
        .unwrap_or_else(|_| payload.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_browser_forward_with_explicit_worker_target() {
        let req = SignalMessage {
            id: signal_ids::JOIN_ROOM.to_string(),
            data: Some("room-1".to_string()),
            session_id: Some("worker-123".to_string()),
        };

        let parsed = parse_browser_command(req).expect("joinRoom should parse");
        match parsed {
            BrowserCommand::ForwardToWorker {
                worker_id,
                event: WorkerEventKind::JoinRoom,
                data,
                bind_client,
            } => {
                assert_eq!(worker_id, "worker-123");
                assert_eq!(data.as_deref(), Some("room-1"));
                assert!(bind_client);
            }
            other => panic!("unexpected parse result: {:?}", other),
        }
    }

    #[test]
    fn rejects_missing_browser_target_for_forward_messages() {
        let req = SignalMessage {
            id: signal_ids::INIT_WEBRTC.to_string(),
            data: None,
            session_id: None,
        };
        let parsed = parse_browser_command(req);
        assert!(matches!(parsed, Err(ProtocolError::MissingTarget { .. })));
    }

    #[test]
    fn rejects_invalid_worker_player_count_payload() {
        let req = SignalMessage {
            id: signal_ids::UPDATE_PLAYER_COUNT.to_string(),
            data: Some("not-a-number".to_string()),
            session_id: None,
        };
        let parsed = parse_worker_command(req);
        assert!(matches!(
            parsed,
            Err(ProtocolError::InvalidPlayerCount { .. })
        ));
    }

    #[test]
    fn parses_controller_join_request() {
        let req = SignalMessage {
            id: signal_ids::CONTROLLER_JOIN.to_string(),
            data: Some("ABC123".to_string()),
            session_id: None,
        };

        let parsed = parse_browser_command(req).expect("controllerJoin should parse");
        match parsed {
            BrowserCommand::ControllerJoin { code } => assert_eq!(code, "ABC123"),
            other => panic!("unexpected parse result: {:?}", other),
        }
    }

    #[test]
    fn parses_controller_input() {
        let req = SignalMessage {
            id: signal_ids::CONTROLLER_INPUT.to_string(),
            data: Some("payload".to_string()),
            session_id: Some("host-1".to_string()),
        };
        let parsed = parse_browser_command(req).expect("controllerInput should parse");
        match parsed {
            BrowserCommand::ControllerInput {
                host_client_id,
                data,
            } => {
                assert_eq!(host_client_id, "host-1");
                assert_eq!(data, "payload");
            }
            other => panic!("unexpected parse result: {:?}", other),
        }
    }

    #[test]
    fn parse_message_text_accepts_legacy_session_id_field() {
        let parsed = parse_browser_message_text(
            r#"{"id":"joinRoom","session_id":" worker-123 ","data":" room-1 "}"#,
        )
        .expect("browser message should parse");

        assert_eq!(parsed.id, signal_ids::JOIN_ROOM);
        assert_eq!(parsed.session_id.as_deref(), Some("worker-123"));
        assert_eq!(parsed.data.as_deref(), Some("room-1"));
    }

    #[test]
    fn parse_message_text_canonicalizes_legacy_answer_payload() {
        let raw = BASE64_STANDARD.encode("v=0\r\n");
        let parsed = parse_browser_message_text(
            &format!(r#"{{"id":"answer","sessionID":"worker-1","data":"{raw}"}}"#),
        )
        .expect("answer should parse");

        let decoded = BASE64_STANDARD
            .decode(parsed.data.expect("payload"))
            .expect("decode canonical payload");
        let json: Value = serde_json::from_slice(&decoded).expect("json payload");
        assert_eq!(json["type"], "answer");
        assert_eq!(json["sdp"], "v=0\r\n");
    }

    #[test]
    fn parse_message_text_canonicalizes_string_candidate_payload() {
        let raw = BASE64_STANDARD.encode("candidate:1 1 UDP 1 127.0.0.1 1234 typ host");
        let parsed = parse_worker_message_text(
            &format!(r#"{{"id":"candidate","sessionID":"client-1","data":"{raw}"}}"#),
        )
        .expect("candidate should parse");

        let decoded = BASE64_STANDARD
            .decode(parsed.data.expect("payload"))
            .expect("decode canonical payload");
        let json: Value = serde_json::from_slice(&decoded).expect("json payload");
        assert_eq!(json["candidate"], "candidate:1 1 UDP 1 127.0.0.1 1234 typ host");
    }
}
