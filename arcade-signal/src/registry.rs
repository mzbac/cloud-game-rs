use std::collections::HashMap;

use tokio::sync::Mutex;

use crate::protocol::Tx;

pub struct ClientDrop {
    pub worker_id: Option<String>,
}

pub struct WorkerDrop {
    pub clients_to_close: Vec<(String, Tx)>,
}

pub struct Registry {
    inner: Mutex<RegistryState>,
}

struct RegistryState {
    clients: HashMap<String, Tx>,
    workers: HashMap<String, Tx>,
    client_to_worker: HashMap<String, String>,
    game_rooms: HashMap<String, String>,
    player_counts: HashMap<String, usize>,
    worker_order: HashMap<String, u64>,
    next_worker_order: u64,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RegistryState {
                clients: HashMap::new(),
                workers: HashMap::new(),
                client_to_worker: HashMap::new(),
                game_rooms: HashMap::new(),
                player_counts: HashMap::new(),
                worker_order: HashMap::new(),
                next_worker_order: 0,
            }),
        }
    }

    pub async fn register_client(&self, client_id: String, tx: Tx) {
        let mut state = self.inner.lock().await;
        state.clients.insert(client_id, tx);
    }

    pub async fn register_worker(&self, worker_id: String, tx: Tx) {
        let mut state = self.inner.lock().await;
        state.workers.insert(worker_id.clone(), tx);
        let order = state.next_worker_order;
        state.next_worker_order = state.next_worker_order.saturating_add(1);
        state.worker_order.insert(worker_id, order);
    }

    pub async fn unregister_client(&self, client_id: &str) -> ClientDrop {
        let mut state = self.inner.lock().await;
        state.clients.remove(client_id);
        let worker_id = state.client_to_worker.remove(client_id);
        ClientDrop { worker_id }
    }

    pub async fn unregister_worker(&self, worker_id: &str) -> WorkerDrop {
        let mut state = self.inner.lock().await;
        state.workers.remove(worker_id);
        state.worker_order.remove(worker_id);
        state.game_rooms.remove(worker_id);
        state.player_counts.remove(worker_id);

        let affected_client_ids: Vec<String> = state
            .client_to_worker
            .iter()
            .filter_map(|(client_id, assigned_worker)| {
                (assigned_worker == worker_id).then_some(client_id.clone())
            })
            .collect();

        let mut clients_to_close = Vec::new();
        for client_id in affected_client_ids {
            state.client_to_worker.remove(&client_id);
            if let Some(tx) = state.clients.remove(&client_id) {
                clients_to_close.push((client_id, tx));
            }
        }

        WorkerDrop { clients_to_close }
    }

    pub async fn bind_client_to_worker(&self, client_id: &str, worker_id: &str) {
        let mut state = self.inner.lock().await;
        state
            .client_to_worker
            .insert(client_id.to_string(), worker_id.to_string());
    }

    pub async fn unbind_client(&self, client_id: &str) {
        let mut state = self.inner.lock().await;
        state.client_to_worker.remove(client_id);
    }

    pub async fn worker_for_client(&self, client_id: &str) -> Option<String> {
        let state = self.inner.lock().await;
        state.client_to_worker.get(client_id).cloned()
    }

    pub async fn is_client_bound_to_worker(&self, client_id: &str, worker_id: &str) -> bool {
        let state = self.inner.lock().await;
        state
            .client_to_worker
            .get(client_id)
            .is_some_and(|bound_worker_id| bound_worker_id == worker_id)
    }

    pub async fn client_sender(&self, client_id: &str) -> Option<Tx> {
        let state = self.inner.lock().await;
        state.clients.get(client_id).cloned()
    }

    pub async fn worker_sender(&self, worker_id: &str) -> Option<Tx> {
        let state = self.inner.lock().await;
        state.workers.get(worker_id).cloned()
    }

    pub async fn all_clients(&self) -> Vec<(String, Tx)> {
        let state = self.inner.lock().await;
        state
            .clients
            .iter()
            .map(|(client_id, tx)| (client_id.clone(), tx.clone()))
            .collect()
    }

    pub async fn set_worker_game(&self, worker_id: String, game_name: Option<String>) -> bool {
        let Some(game_name) = game_name else {
            return false;
        };
        if normalize_game_name(&game_name).is_empty() {
            return false;
        }

        let mut state = self.inner.lock().await;
        state.game_rooms.insert(worker_id, game_name);
        true
    }

    pub async fn games_payload(&self, dedupe_rooms_by_game: bool) -> String {
        let state = self.inner.lock().await;
        if !dedupe_rooms_by_game {
            return serde_json::to_string(&state.game_rooms).unwrap_or_else(|_| "{}".to_string());
        }

        let mut selected: HashMap<String, (u64, String, String)> = HashMap::new();
        for (worker_id, game_name) in state.game_rooms.iter() {
            let normalized = normalize_game_name(game_name);
            if normalized.is_empty() {
                continue;
            }

            let order = state
                .worker_order
                .get(worker_id)
                .copied()
                .unwrap_or(u64::MAX);
            match selected.get_mut(&normalized) {
                Some(existing) => {
                    if order < existing.0 || (order == existing.0 && worker_id < &existing.1) {
                        *existing = (order, worker_id.clone(), game_name.clone());
                    }
                }
                None => {
                    selected.insert(normalized, (order, worker_id.clone(), game_name.clone()));
                }
            }
        }

        let mut deduped: HashMap<String, String> = HashMap::new();
        for (_normalized, (_order, worker_id, game_name)) in selected {
            deduped.insert(worker_id, game_name);
        }

        serde_json::to_string(&deduped).unwrap_or_else(|_| "{}".to_string())
    }

    pub async fn set_worker_player_count(&self, worker_id: String, count: usize) {
        let mut state = self.inner.lock().await;
        state.player_counts.insert(worker_id, count);
    }

    pub async fn player_counts_snapshot(&self) -> Vec<(String, usize)> {
        let state = self.inner.lock().await;
        state
            .player_counts
            .iter()
            .map(|(worker_id, count)| (worker_id.clone(), *count))
            .collect()
    }
}

fn normalize_game_name(name: &str) -> String {
    name.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}
