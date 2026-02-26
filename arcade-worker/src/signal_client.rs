use arcade_signal_protocol::{ids as signal_ids, SignalMessage};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use crossbeam_channel::Sender;
use futures_util::{SinkExt, StreamExt};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

use crate::room::{InputEvent, Room};
use crate::url_utils;
use crate::webrtc_session;

const MAX_PENDING_SESSIONS: usize = 512;
const MAX_PENDING_MESSAGES_PER_SESSION: usize = 32;

#[derive(Default)]
struct PendingSessionSignals {
    by_session: HashMap<String, VecDeque<SignalMessage>>,
}

impl PendingSessionSignals {
    fn enqueue(&mut self, msg: SignalMessage) {
        let Some(session_id) = signal_session_id(&msg) else {
            return;
        };

        if !self.by_session.contains_key(&session_id) && self.by_session.len() >= MAX_PENDING_SESSIONS {
            if let Some(first_key) = self.by_session.keys().next().cloned() {
                self.by_session.remove(&first_key);
            }
        }

        let queue = self.by_session.entry(session_id).or_default();
        if queue.len() >= MAX_PENDING_MESSAGES_PER_SESSION {
            queue.pop_front();
        }
        queue.push_back(msg);
    }

    fn drain(&mut self, session_id: &str) -> Vec<SignalMessage> {
        self.by_session
            .remove(session_id)
            .map(|queue| queue.into_iter().collect())
            .unwrap_or_default()
    }

    fn clear(&mut self, session_id: &str) {
        self.by_session.remove(session_id);
    }
}

pub(crate) async fn run_signal_client(
    signal_url: String,
    signal_rx: mpsc::UnboundedReceiver<SignalMessage>,
    room: Arc<Room>,
    input_sender: Sender<InputEvent>,
) {
    let signal_url_for_log = url_utils::redact_url_query_param_for_log(&signal_url, "token");
    let (ws_stream, _response) = match connect_async(&signal_url).await {
        Ok((socket, response)) => {
            info!(signal_url = %signal_url_for_log, "connected to signaling server");
            let _ = response;
            (socket, response)
        }
        Err(err) => {
            warn!(
                signal_url = %signal_url_for_log,
                error = %err,
                "signaling websocket connect failed"
            );
            return;
        }
    };

    let (mut writer, mut reader) = ws_stream.split();
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<SignalMessage>();
    tokio::spawn(async move {
        while let Some(msg) = outbound_rx.recv().await {
            if let Ok(payload) = serde_json::to_string(&msg) {
                if writer.send(Message::Text(payload.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    let mut signal_rx = signal_rx;
    let signal_outbound = outbound_tx.clone();
    tokio::spawn(async move {
        while let Some(msg) = signal_rx.recv().await {
            if signal_outbound.send(msg).is_err() {
                break;
            }
        }
    });

    let room_for_msg = room.clone();
    let mut pending_signals = PendingSessionSignals::default();
    while let Some(Ok(msg)) = reader.next().await {
        match msg {
            Message::Text(text) => match serde_json::from_str::<SignalMessage>(&text) {
                Ok(req) => {
                    handle_signal_message(
                        req,
                        room_for_msg.clone(),
                        outbound_tx.clone(),
                        input_sender.clone(),
                        &mut pending_signals,
                    )
                    .await
                }
                Err(err) => warn!(error = %err, "invalid signaling payload"),
            },
            Message::Close(_) => break,
            _ => {}
        }
    }
}

async fn replay_pending_signals(
    session_id: &str,
    room: Arc<Room>,
    input_sender: Sender<InputEvent>,
    pending_signals: &mut PendingSessionSignals,
) {
    let pending = pending_signals.drain(session_id);
    if pending.is_empty() {
        return;
    }

    debug!(
        session_id,
        pending_count = pending.len(),
        "replaying queued signaling messages"
    );

    for pending_msg in pending {
        handle_non_init_signal_message(
            pending_msg,
            room.clone(),
            input_sender.clone(),
            pending_signals,
        )
        .await;
    }
}

async fn handle_signal_message(
    msg: SignalMessage,
    room: Arc<Room>,
    outbound: mpsc::UnboundedSender<SignalMessage>,
    input_sender: Sender<InputEvent>,
    pending_signals: &mut PendingSessionSignals,
) {
    match msg.id.as_str() {
        signal_ids::INIT_WEBRTC => {
            let Some(session_id) = signal_session_id(&msg) else {
                warn!("initwebrtc missing sessionID");
                return;
            };

            if let Err(err) = webrtc_session::create_session(
                session_id.clone(),
                room.clone(),
                outbound.clone(),
                input_sender.clone(),
            )
            .await
            {
                warn!(session_id, error = %err, "initwebrtc failed");
                return;
            }

            replay_pending_signals(
                &session_id,
                room.clone(),
                input_sender.clone(),
                pending_signals,
            )
            .await;
        }
        signal_ids::TERMINATE_SESSION => {
            let Some(session_id) = signal_session_id(&msg) else {
                warn!("terminateSession missing sessionID");
                return;
            };
            pending_signals.clear(&session_id);
            room.release_input_source(&session_id);
            if let Some(session) = room.unregister_session(&session_id) {
                let peer = Arc::clone(session.peer());
                tokio::spawn(async move {
                    if let Err(err) = peer.close().await {
                        warn!(session_id, error = %err, "peer close failed");
                    }
                });
            }
        }
        _ => {
            handle_non_init_signal_message(msg, room, input_sender, pending_signals).await
        }
    }
}

async fn handle_non_init_signal_message(
    msg: SignalMessage,
    room: Arc<Room>,
    input_sender: Sender<InputEvent>,
    pending_signals: &mut PendingSessionSignals,
) {
    match msg.id.as_str() {
        signal_ids::ANSWER => {
            let Some(session_id) = signal_session_id(&msg) else {
                warn!("answer missing sessionID");
                return;
            };
            let Some(data) = signal_payload(&msg) else {
                warn!(session_id, "answer missing payload");
                return;
            };

            if let Some(session) = room.with_session(&session_id) {
                if let Err(err) = webrtc_session::apply_answer(session.peer(), &data).await {
                    warn!(session_id, error = %err, "failed applying answer");
                }
            } else {
                debug!(session_id, "queueing answer until session is registered");
                pending_signals.enqueue(msg);
            }
        }
        signal_ids::CANDIDATE => {
            let Some(session_id) = signal_session_id(&msg) else {
                warn!("candidate missing sessionID");
                return;
            };
            let Some(data) = signal_payload(&msg) else {
                warn!(session_id, "candidate missing payload");
                return;
            };

            if let Some(session) = room.with_session(&session_id) {
                if let Err(err) = webrtc_session::apply_candidate(session.peer(), &data).await {
                    warn!(session_id, error = %err, "failed adding candidate");
                }
            } else {
                debug!(session_id, "queueing candidate until session is registered");
                pending_signals.enqueue(msg);
            }
        }
        signal_ids::JOIN_ROOM => {
            let Some(session_id) = signal_session_id(&msg) else {
                warn!("joinRoom missing sessionID");
                return;
            };

            apply_join_room(room.as_ref(), &session_id);
        }
        signal_ids::INPUT => {
            let Some(session_id) = signal_session_id(&msg) else {
                warn!("input missing sessionID");
                return;
            };
            let Some(payload) = signal_payload(&msg) else {
                warn!(session_id, "input missing payload");
                return;
            };

            match BASE64_STANDARD.decode(payload) {
                Ok(values) => {
                    room.buffer_or_send_input(&session_id, values, &input_sender, "signal");
                }
                Err(err) => warn!(session_id, error = %err, "failed to decode input payload"),
            }
        }
        _ => debug!(id = %msg.id, "ignored signal message"),
    }
}

fn apply_join_room(room: &Room, session_id: &str) {
    if let Some(index) = room.join_room(session_id) {
        info!(session_id, index, "session joined room");
    } else {
        info!(session_id, "session joined room as spectator");
    }
}

fn signal_session_id(msg: &SignalMessage) -> Option<String> {
    msg.session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn signal_payload(msg: &SignalMessage) -> Option<String> {
    msg.data
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_signals_limits_queue_size_per_session() {
        let mut pending = PendingSessionSignals::default();
        for idx in 0..(MAX_PENDING_MESSAGES_PER_SESSION + 8) {
            pending.enqueue(SignalMessage::with_payload(
                signal_ids::ANSWER,
                Some("session-a".to_string()),
                Some(format!("payload-{idx}")),
            ));
        }

        let drained = pending.drain("session-a");
        assert_eq!(drained.len(), MAX_PENDING_MESSAGES_PER_SESSION);
        assert_eq!(
            drained.first().and_then(|msg| msg.data.clone()),
            Some("payload-8".to_string())
        );
    }

    #[test]
    fn session_and_payload_extractors_trim_and_reject_empty_values() {
        let valid = SignalMessage::with_payload(
            signal_ids::INPUT,
            Some("  session-1  ".to_string()),
            Some("  payload ".to_string()),
        );
        assert_eq!(signal_session_id(&valid), Some("session-1".to_string()));
        assert_eq!(signal_payload(&valid), Some("payload".to_string()));

        let missing = SignalMessage::with_payload(
            signal_ids::INPUT,
            Some("   ".to_string()),
            Some("".to_string()),
        );
        assert_eq!(signal_session_id(&missing), None);
        assert_eq!(signal_payload(&missing), None);
    }
}
