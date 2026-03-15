use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use arcade_signal_protocol::SignalMessage;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use axum::response::{IntoResponse, Response};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::controllers::{Controllers, JOIN_CODE_TTL};
use crate::protocol::{
    controller_audio_message, controller_joined_message, controller_left_message,
    controller_ready_message, controller_rejected_message, forward_to_client_message,
    forward_to_worker_message, games_message, parse_browser_command, parse_worker_command,
    terminate_session_message, update_player_count_message, BrowserCommand, OutboundEvent, Tx,
    WorkerCommand, WorkerEventKind,
};
use crate::registry::Registry;

static SESSION_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

pub type SharedState = Arc<AppState>;

#[derive(Clone)]
pub struct AppState {
    registry: Arc<Registry>,
    controllers: Arc<Controllers>,
    auth_token: Option<String>,
    allowed_origins: Option<HashSet<String>>,
    dedupe_rooms_by_game: bool,
}

impl AppState {
    pub fn new(
        auth_token: Option<String>,
        allowed_origins: Option<HashSet<String>>,
        dedupe_rooms_by_game: bool,
    ) -> Self {
        Self {
            registry: Arc::new(Registry::new()),
            controllers: Arc::new(Controllers::new()),
            auth_token,
            allowed_origins,
            dedupe_rooms_by_game,
        }
    }

    fn is_token_valid(&self, candidate: Option<&str>) -> bool {
        match self.auth_token.as_deref() {
            Some(expected) => candidate == Some(expected),
            None => true,
        }
    }

    fn is_origin_allowed(&self, headers: &HeaderMap) -> bool {
        let Some(allowed) = &self.allowed_origins else {
            return true;
        };

        let origin = headers
            .get(axum::http::header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty());

        origin.is_some_and(|value| allowed.contains(value))
    }

    async fn is_client_bound_to_worker(&self, client_id: &str, worker_id: &str) -> bool {
        self.registry
            .is_client_bound_to_worker(client_id, worker_id)
            .await
    }

    async fn send_to_worker(&self, worker_id: &str, msg: SignalMessage) {
        if let Some(tx) = self.registry.worker_sender(worker_id).await {
            if let Err(err) = tx.send(OutboundEvent::Message(msg)) {
                warn!("failed to send to worker {}: {}", worker_id, err);
            }
        }
    }

    async fn send_to_client(&self, client_id: &str, msg: SignalMessage) {
        if let Some(tx) = self.registry.client_sender(client_id).await {
            if let Err(err) = tx.send(OutboundEvent::Message(msg)) {
                warn!("failed to send to client {}: {}", client_id, err);
            }
        }
    }

    async fn broadcast_to_clients(&self, msg: SignalMessage) {
        for (client_id, tx) in self.registry.all_clients().await {
            if let Err(err) = tx.send(OutboundEvent::Message(msg.clone())) {
                warn!("failed to send broadcast message to client {}: {}", client_id, err);
            }
        }
    }

    async fn broadcast_games(&self) {
        let payload = self.registry.games_payload(self.dedupe_rooms_by_game).await;
        self.broadcast_to_clients(games_message(payload)).await;
    }

    async fn send_browser_initial_state(&self, tx: &Tx) {
        let snapshot = self.browser_snapshot_payload().await;
        let games_payload = snapshot
            .get("games")
            .cloned()
            .unwrap_or_else(|| json!({}))
            .to_string();
        let _ = tx.send(OutboundEvent::Message(games_message(games_payload)));

        for (worker_id, count) in self.registry.player_counts_snapshot().await {
            let msg = update_player_count_message(worker_id, count);
            let _ = tx.send(OutboundEvent::Message(msg));
        }
    }

    async fn browser_snapshot_payload(&self) -> Value {
        let games_raw = self.registry.games_payload(self.dedupe_rooms_by_game).await;
        let games = serde_json::from_str::<Value>(&games_raw).unwrap_or_else(|_| json!({}));

        let player_counts = self
            .registry
            .player_counts_snapshot()
            .await
            .into_iter()
            .map(|(worker_id, count)| (worker_id, Value::from(count)))
            .collect::<Map<String, Value>>();

        json!({
            "games": games,
            "playerCountsByRoom": player_counts,
        })
    }

    async fn handle_browser_message(&self, client_id: &str, req: SignalMessage) {
        match parse_browser_command(req) {
            Ok(BrowserCommand::RequestGames) => {
                let payload = self.registry.games_payload(self.dedupe_rooms_by_game).await;
                self.send_to_client(client_id, games_message(payload)).await;
            }
            Ok(BrowserCommand::ForwardToWorker {
                worker_id,
                event,
                data,
                bind_client,
            }) => {
                if bind_client {
                    if self.registry.worker_sender(&worker_id).await.is_none() {
                        warn!(
                            "blocked browser bind from {} to unknown worker {}",
                            client_id, worker_id
                        );
                        return;
                    }
                    self.registry.bind_client_to_worker(client_id, &worker_id).await;
                } else if !self.is_client_bound_to_worker(client_id, &worker_id).await {
                    warn!(
                        "blocked browser relay route {} -> {} without matching worker binding",
                        client_id, worker_id
                    );
                    return;
                }
                let msg = forward_to_worker_message(event, client_id.to_string(), data);
                self.send_to_worker(&worker_id, msg).await;
            }
            Ok(BrowserCommand::TerminateSession { worker_id }) => {
                let bound_worker_id = self.registry.worker_for_client(client_id).await;
                let worker_id = match (worker_id, bound_worker_id) {
                    (Some(worker_id), Some(bound_worker_id)) if worker_id == bound_worker_id => {
                        Some(bound_worker_id)
                    }
                    (Some(worker_id), Some(bound_worker_id)) => {
                        warn!(
                            "blocked terminate route {} -> {} (bound to {})",
                            client_id, worker_id, bound_worker_id
                        );
                        None
                    }
                    (Some(worker_id), None) => {
                        warn!(
                            "blocked terminate route {} -> {} without worker binding",
                            client_id, worker_id
                        );
                        None
                    }
                    (None, bound_worker_id) => bound_worker_id,
                };
                if let Some(worker_id) = worker_id {
                    self.send_to_worker(&worker_id, terminate_session_message(client_id))
                        .await;
                    self.registry.unbind_client(client_id).await;
                }
            }
            Ok(BrowserCommand::ControllerHost { worker_id }) => {
                if !self.is_client_bound_to_worker(client_id, &worker_id).await {
                    warn!(
                        "blocked controller host registration {} -> {} without matching worker binding",
                        client_id, worker_id
                    );
                    return;
                }
                let code = self.controllers.register_host(client_id, &worker_id).await;
                let payload = serde_json::json!({
                    "code": code,
                    "workerID": worker_id,
                    "expiresInSeconds": JOIN_CODE_TTL.as_secs(),
                })
                .to_string();
                self.send_to_client(client_id, controller_ready_message(payload))
                    .await;
            }
            Ok(BrowserCommand::ControllerJoin { code }) => match self.controllers.join(client_id, &code).await {
                Ok(target) => {
                    self.send_to_client(client_id, controller_joined_message(target.host_client_id.clone()))
                        .await;
                    self.send_to_client(&target.host_client_id, controller_joined_message(client_id.to_string()))
                        .await;
                    let join_msg = forward_to_worker_message(
                        WorkerEventKind::JoinRoom,
                        client_id.to_string(),
                        None,
                    );
                    self.send_to_worker(&target.worker_id, join_msg).await;
                }
                Err(reason) => {
                    self.send_to_client(client_id, controller_rejected_message(reason))
                        .await;
                }
            },
            Ok(BrowserCommand::ControllerInput { host_client_id, data }) => {
                let Some(worker_id) = self.controllers.worker_for_input(client_id, &host_client_id).await else {
                    warn!(
                        "blocked invalid controller relay route {} -> {}",
                        client_id, host_client_id
                    );
                    return;
                };

                let msg = forward_to_worker_message(
                    WorkerEventKind::Input,
                    client_id.to_string(),
                    Some(data),
                );
                self.send_to_worker(&worker_id, msg).await;
            }
            Ok(BrowserCommand::ControllerAudio { host_client_id, action }) => {
                let Some(_) = self.controllers.worker_for_input(client_id, &host_client_id).await else {
                    warn!(
                        "blocked invalid controller audio route {} -> {}",
                        client_id, host_client_id
                    );
                    return;
                };

                self.send_to_client(
                    &host_client_id,
                    controller_audio_message(client_id.to_string(), action),
                )
                .await;
            }
            Err(err) => warn!("invalid browser message from {}: {}", client_id, err),
        }
    }

    async fn handle_worker_message(&self, worker_id: &str, req: SignalMessage) {
        match parse_worker_command(req) {
            Ok(WorkerCommand::GameInfo { game_name }) => {
                let updated = self
                    .registry
                    .set_worker_game(worker_id.to_string(), game_name)
                    .await;
                if updated {
                    self.broadcast_games().await;
                } else {
                    warn!("ignoring empty game name from worker {}", worker_id);
                }
            }
            Ok(WorkerCommand::ForwardToClient {
                client_id,
                event,
                data,
            }) => {
                let msg = forward_to_client_message(event, client_id.clone(), data);
                self.send_to_client(&client_id, msg).await;
            }
            Ok(WorkerCommand::UpdatePlayerCount { count }) => {
                self.registry
                    .set_worker_player_count(worker_id.to_string(), count)
                    .await;
                let msg = update_player_count_message(worker_id.to_string(), count);
                self.broadcast_to_clients(msg).await;
            }
            Err(err) => warn!("invalid worker message from {}: {}", worker_id, err),
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum PeerRole {
    Browser,
    Worker,
}

impl PeerRole {
    fn label(self) -> &'static str {
        match self {
            Self::Browser => "browser client",
            Self::Worker => "worker client",
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct WsAuthQuery {
    token: Option<String>,
}

pub async fn browser_ws(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(query): Query<WsAuthQuery>,
) -> Response {
    if !state.is_origin_allowed(&headers) {
        warn!("blocked websocket request with disallowed Origin");
        return StatusCode::FORBIDDEN.into_response();
    }

    if !state.is_token_valid(query.token.as_deref()) {
        warn!("blocked websocket request with invalid token");
        return StatusCode::UNAUTHORIZED.into_response();
    }

    ws.on_upgrade(move |socket| run_peer_socket(socket, state, PeerRole::Browser))
}

pub async fn browser_snapshot(
    State(state): State<SharedState>,
    Query(query): Query<WsAuthQuery>,
) -> Response {
    if !state.is_token_valid(query.token.as_deref()) {
        warn!("blocked snapshot request with invalid token");
        return StatusCode::UNAUTHORIZED.into_response();
    }

    Json(state.browser_snapshot_payload().await).into_response()
}

pub async fn worker_ws(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Query(query): Query<WsAuthQuery>,
) -> Response {
    if !state.is_token_valid(query.token.as_deref()) {
        warn!("blocked worker websocket request with invalid token");
        return StatusCode::UNAUTHORIZED.into_response();
    }

    ws.on_upgrade(move |socket| run_peer_socket(socket, state, PeerRole::Worker))
}

fn spawn_ws_writer(
    mut sender: SplitSink<WebSocket, Message>,
    mut rx: mpsc::UnboundedReceiver<OutboundEvent>,
    peer_label: &'static str,
    peer_id: String,
) {
    tokio::spawn(async move {
        while let Some(evt) = rx.recv().await {
            match evt {
                OutboundEvent::Message(msg) => {
                    let payload = match serde_json::to_string(&msg) {
                        Ok(value) => value,
                        Err(err) => {
                            warn!(
                                "failed to serialize message for {} {}: {}",
                                peer_label, peer_id, err
                            );
                            continue;
                        }
                    };

                    if sender.send(Message::Text(payload)).await.is_err() {
                        break;
                    }
                }
                OutboundEvent::Close => {
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
            }
        }

        let _ = sender.send(Message::Close(None)).await;
    });
}

async fn run_peer_socket(socket: WebSocket, state: SharedState, role: PeerRole) {
    let peer_id = next_session_id();
    let (sender, mut receiver) = socket.split();
    let (tx, rx) = mpsc::unbounded_channel::<OutboundEvent>();
    info!("{} connected: {}", role.label(), peer_id);

    match role {
        PeerRole::Browser => {
            state.registry.register_client(peer_id.clone(), tx.clone()).await;
            state.send_browser_initial_state(&tx).await;
        }
        PeerRole::Worker => {
            state.registry.register_worker(peer_id.clone(), tx.clone()).await;
        }
    }

    spawn_ws_writer(sender, rx, role.label(), peer_id.clone());

    while let Some(Ok(message)) = receiver.next().await {
        match message {
            Message::Text(text) => match serde_json::from_str::<SignalMessage>(&text) {
                Ok(req) => match role {
                    PeerRole::Browser => state.handle_browser_message(&peer_id, req).await,
                    PeerRole::Worker => state.handle_worker_message(&peer_id, req).await,
                },
                Err(err) => warn!("invalid message from {} {}: {}", role.label(), peer_id, err),
            },
            Message::Close(_) => break,
            Message::Pong(_) | Message::Ping(_) => {}
            _ => {}
        }
    }

    info!("{} disconnected: {}", role.label(), peer_id);
    match role {
        PeerRole::Browser => cleanup_browser(&state, &peer_id).await,
        PeerRole::Worker => cleanup_worker(&state, &peer_id).await,
    }
}

async fn cleanup_browser(state: &SharedState, client_id: &str) {
    let controller_cleanup = state.controllers.cleanup_peer(client_id).await;
    let dropped = state.registry.unregister_client(client_id).await;
    if let Some(worker_id) = dropped.worker_id {
        state
            .send_to_worker(&worker_id, terminate_session_message(client_id))
            .await;
    }

    if let Some(host_client_id) = controller_cleanup.notify_host {
        state
            .send_to_client(&host_client_id, controller_left_message(client_id.to_string()))
            .await;
    }

    for controller_client_id in controller_cleanup.notify_controllers {
        state
            .send_to_client(
                &controller_client_id,
                controller_left_message(client_id.to_string()),
            )
            .await;
    }

    for (worker_id, session_id) in controller_cleanup.worker_terminations {
        state
            .send_to_worker(&worker_id, terminate_session_message(&session_id))
            .await;
    }
}

async fn cleanup_worker(state: &SharedState, worker_id: &str) {
    let dropped = state.registry.unregister_worker(worker_id).await;
    for (client_id, tx) in dropped.clients_to_close {
        if let Err(err) = tx.send(OutboundEvent::Close) {
            warn!("failed to close client {}: {}", client_id, err);
        }
    }
    state.broadcast_games().await;
}

fn next_session_id() -> String {
    let seq = SESSION_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{:x}", nanos, seq)
}

#[cfg(test)]
mod tests {
    use super::*;

    use arcade_signal_protocol::ids as signal_ids;
    use tokio::sync::mpsc;
    use tokio::sync::mpsc::error::TryRecvError;

    async fn register_worker(state: &AppState, worker_id: &str) -> mpsc::UnboundedReceiver<OutboundEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        state.registry.register_worker(worker_id.to_string(), tx).await;
        rx
    }

    async fn register_client(state: &AppState, client_id: &str) -> mpsc::UnboundedReceiver<OutboundEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        state.registry.register_client(client_id.to_string(), tx).await;
        rx
    }

    #[tokio::test]
    async fn unbound_browser_input_is_blocked() {
        let state = AppState::new(None, None, false);
        let client_id = "client-a";
        let worker_id = "worker-a";
        let mut worker_rx = register_worker(&state, worker_id).await;

        state
            .handle_browser_message(
                client_id,
                SignalMessage::with_payload(
                    signal_ids::INPUT,
                    Some(worker_id.to_string()),
                    Some("AQI=".to_string()),
                ),
            )
            .await;

        assert!(matches!(worker_rx.try_recv(), Err(TryRecvError::Empty)));
    }

    #[tokio::test]
    async fn bound_browser_input_is_forwarded() {
        let state = AppState::new(None, None, false);
        let client_id = "client-a";
        let worker_id = "worker-a";
        let mut worker_rx = register_worker(&state, worker_id).await;
        state.registry.bind_client_to_worker(client_id, worker_id).await;

        state
            .handle_browser_message(
                client_id,
                SignalMessage::with_payload(
                    signal_ids::INPUT,
                    Some(worker_id.to_string()),
                    Some("AQI=".to_string()),
                ),
            )
            .await;

        let forwarded = worker_rx.try_recv().expect("expected worker message");
        match forwarded {
            OutboundEvent::Message(msg) => {
                assert_eq!(msg.id, signal_ids::INPUT);
                assert_eq!(msg.session_id.as_deref(), Some(client_id));
                assert_eq!(msg.data.as_deref(), Some("AQI="));
            }
            OutboundEvent::Close => panic!("expected message event"),
        }
    }

    #[tokio::test]
    async fn browser_bind_to_unknown_worker_is_blocked() {
        let state = AppState::new(None, None, false);
        let client_id = "client-a";

        state
            .handle_browser_message(
                client_id,
                SignalMessage::with_payload(
                    signal_ids::INIT_WEBRTC,
                    Some("worker-missing".to_string()),
                    None,
                ),
            )
            .await;

        assert_eq!(state.registry.worker_for_client(client_id).await, None);
    }

    #[tokio::test]
    async fn controller_host_requires_matching_worker_binding() {
        let state = AppState::new(None, None, false);
        let client_id = "client-a";
        let worker_id = "worker-a";
        let mut client_rx = register_client(&state, client_id).await;
        let _worker_rx = register_worker(&state, worker_id).await;

        state
            .handle_browser_message(
                client_id,
                SignalMessage::with_payload(
                    signal_ids::CONTROLLER_HOST,
                    Some(worker_id.to_string()),
                    None,
                ),
            )
            .await;

        assert!(matches!(client_rx.try_recv(), Err(TryRecvError::Empty)));

        state.registry.bind_client_to_worker(client_id, worker_id).await;
        state
            .handle_browser_message(
                client_id,
                SignalMessage::with_payload(
                    signal_ids::CONTROLLER_HOST,
                    Some(worker_id.to_string()),
                    None,
                ),
            )
            .await;

        let ready = client_rx.try_recv().expect("expected controller ready");
        match ready {
            OutboundEvent::Message(msg) => {
                assert_eq!(msg.id, signal_ids::CONTROLLER_READY);
                let payload = serde_json::from_str::<Value>(msg.data.as_deref().unwrap_or("{}"))
                    .expect("controller ready payload should be json");
                assert_eq!(payload.get("workerID").and_then(Value::as_str), Some(worker_id));
                let code = payload.get("code").and_then(Value::as_str).unwrap_or_default();
                assert_eq!(code.len(), 6);
            }
            OutboundEvent::Close => panic!("expected message event"),
        }
    }

    #[tokio::test]
    async fn terminate_with_mismatched_worker_target_is_blocked() {
        let state = AppState::new(None, None, false);
        let client_id = "client-a";
        let worker_id = "worker-a";
        let other_worker_id = "worker-b";
        let mut worker_rx = register_worker(&state, worker_id).await;
        let mut other_worker_rx = register_worker(&state, other_worker_id).await;
        state.registry.bind_client_to_worker(client_id, worker_id).await;

        state
            .handle_browser_message(
                client_id,
                SignalMessage::with_payload(
                    signal_ids::TERMINATE_SESSION,
                    Some(other_worker_id.to_string()),
                    None,
                ),
            )
            .await;

        assert!(matches!(worker_rx.try_recv(), Err(TryRecvError::Empty)));
        assert!(matches!(other_worker_rx.try_recv(), Err(TryRecvError::Empty)));
        assert_eq!(
            state.registry.worker_for_client(client_id).await,
            Some(worker_id.to_string())
        );
    }
}
