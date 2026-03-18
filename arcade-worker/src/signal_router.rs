use arcade_signal_protocol::{ids as signal_ids, SignalMessage};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use crossbeam_channel::Sender;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::room::{InputEvent, Room};
use crate::webrtc_session;

const MAX_PENDING_SESSIONS: usize = 512;
const MAX_PENDING_MESSAGES_PER_SESSION: usize = 32;

#[derive(Default)]
struct PendingSessionSignals {
    by_client: HashMap<String, VecDeque<SignalMessage>>,
}

impl PendingSessionSignals {
    fn enqueue(&mut self, msg: SignalMessage) {
        let Some(client_id) = signal_client_id(&msg) else {
            return;
        };

        if !self.by_client.contains_key(client_id) && self.by_client.len() >= MAX_PENDING_SESSIONS {
            if let Some(first_key) = self.by_client.keys().next().cloned() {
                self.by_client.remove(&first_key);
            }
        }

        let queue = self.by_client.entry(client_id.to_string()).or_default();
        if queue.len() >= MAX_PENDING_MESSAGES_PER_SESSION {
            queue.pop_front();
        }
        queue.push_back(msg);
    }

    fn drain(&mut self, client_id: &str) -> Vec<SignalMessage> {
        self.by_client
            .remove(client_id)
            .map(|queue| queue.into_iter().collect())
            .unwrap_or_default()
    }

    fn clear(&mut self, client_id: &str) {
        self.by_client.remove(client_id);
    }
}

pub(crate) struct SignalRouter {
    room: Arc<Room>,
    outbound: mpsc::UnboundedSender<SignalMessage>,
    input_sender: Sender<InputEvent>,
    pending_signals: PendingSessionSignals,
}

impl SignalRouter {
    pub(crate) fn new(
        room: Arc<Room>,
        outbound: mpsc::UnboundedSender<SignalMessage>,
        input_sender: Sender<InputEvent>,
    ) -> Self {
        Self {
            room,
            outbound,
            input_sender,
            pending_signals: PendingSessionSignals::default(),
        }
    }

    pub(crate) async fn handle_message(&mut self, msg: SignalMessage) {
        match msg.id.as_str() {
            signal_ids::INIT_WEBRTC => self.handle_init_webrtc(msg).await,
            signal_ids::TERMINATE_SESSION => self.handle_terminate_session(msg).await,
            _ => self.handle_non_init_message(msg).await,
        }
    }

    async fn handle_init_webrtc(&mut self, msg: SignalMessage) {
        let Some(client_id) = signal_client_id(&msg).map(ToOwned::to_owned) else {
            warn!("initwebrtc missing sessionID");
            return;
        };

        if let Err(err) = webrtc_session::create_session(
            client_id.clone(),
            self.room.clone(),
            self.outbound.clone(),
            self.input_sender.clone(),
        )
        .await
        {
            warn!(client_id, error = %err, "initwebrtc failed");
            return;
        }

        self.replay_pending_signals(&client_id).await;
    }

    async fn handle_terminate_session(&mut self, msg: SignalMessage) {
        let Some(client_id) = signal_client_id(&msg) else {
            warn!("terminateSession missing sessionID");
            return;
        };
        self.pending_signals.clear(client_id);
        self.room.release_input_source(client_id);
        if let Some(session) = self.room.unregister_client_session(client_id) {
            let peer = Arc::clone(session.peer());
            let client_id = client_id.to_string();
            tokio::spawn(async move {
                if let Err(err) = peer.close().await {
                    warn!(client_id, error = %err, "peer close failed");
                }
            });
        }
    }

    async fn replay_pending_signals(&mut self, client_id: &str) {
        let pending = self.pending_signals.drain(client_id);
        if pending.is_empty() {
            return;
        }

        debug!(
            client_id,
            pending_count = pending.len(),
            "replaying queued signaling messages"
        );

        for pending_msg in pending {
            self.handle_non_init_message(pending_msg).await;
        }
    }

    async fn handle_non_init_message(&mut self, msg: SignalMessage) {
        match msg.id.as_str() {
            signal_ids::ANSWER => self.handle_answer(msg).await,
            signal_ids::CANDIDATE => self.handle_candidate(msg).await,
            signal_ids::JOIN_ROOM => self.handle_join_room(msg),
            signal_ids::INPUT => self.handle_input(msg),
            _ => debug!(id = %msg.id, "ignored signal message"),
        }
    }

    async fn handle_answer(&mut self, msg: SignalMessage) {
        let Some(client_id) = signal_client_id(&msg).map(ToOwned::to_owned) else {
            warn!("answer missing sessionID");
            return;
        };
        let Some(data) = signal_payload(&msg) else {
            warn!(client_id, "answer missing payload");
            return;
        };

        if let Some(session) = self.room.with_client_session(&client_id) {
            if let Err(err) = webrtc_session::apply_answer(session.peer(), data).await {
                warn!(client_id, error = %err, "failed applying answer");
            }
        } else {
            debug!(client_id, "queueing answer until session is registered");
            self.pending_signals.enqueue(msg);
        }
    }

    async fn handle_candidate(&mut self, msg: SignalMessage) {
        let Some(client_id) = signal_client_id(&msg).map(ToOwned::to_owned) else {
            warn!("candidate missing sessionID");
            return;
        };
        let Some(data) = signal_payload(&msg) else {
            warn!(client_id, "candidate missing payload");
            return;
        };

        if let Some(session) = self.room.with_client_session(&client_id) {
            if let Err(err) = webrtc_session::apply_candidate(session.peer(), data).await {
                warn!(client_id, error = %err, "failed adding candidate");
            }
        } else {
            debug!(client_id, "queueing candidate until session is registered");
            self.pending_signals.enqueue(msg);
        }
    }

    fn handle_join_room(&self, msg: SignalMessage) {
        let Some(client_id) = signal_client_id(&msg) else {
            warn!("joinRoom missing sessionID");
            return;
        };

        if let Some(index) = self.room.join_room(client_id) {
            info!(client_id, index, "session joined room");
        } else {
            info!(client_id, "session joined room as spectator");
        }
    }

    fn handle_input(&self, msg: SignalMessage) {
        let Some(client_id) = signal_client_id(&msg) else {
            warn!("input missing sessionID");
            return;
        };
        let Some(payload) = signal_payload(&msg) else {
            warn!(client_id, "input missing payload");
            return;
        };

        match BASE64_STANDARD.decode(payload) {
            Ok(values) => {
                self.room
                    .buffer_or_send_input(client_id, values, &self.input_sender, "signal");
            }
            Err(err) => warn!(client_id, error = %err, "failed to decode input payload"),
        }
    }
}

fn signal_client_id(msg: &SignalMessage) -> Option<&str> {
    msg.session_id.as_deref().filter(|value| !value.is_empty())
}

fn signal_payload(msg: &SignalMessage) -> Option<&str> {
    msg.data.as_deref().filter(|value| !value.is_empty())
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
    fn session_and_payload_extractors_require_canonical_non_empty_values() {
        let valid = SignalMessage::with_payload(
            signal_ids::INPUT,
            Some("session-1".to_string()),
            Some("payload".to_string()),
        );
        assert_eq!(signal_client_id(&valid), Some("session-1"));
        assert_eq!(signal_payload(&valid), Some("payload"));

        let missing = SignalMessage::with_payload(
            signal_ids::INPUT,
            Some(String::new()),
            Some(String::new()),
        );
        assert_eq!(signal_client_id(&missing), None);
        assert_eq!(signal_payload(&missing), None);
    }
}
