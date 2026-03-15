use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::io::Read;

use tokio::sync::Mutex;

pub const JOIN_CODE_TTL: Duration = Duration::from_secs(15 * 60);
const JOIN_CODE_LENGTH: usize = 6;
const JOIN_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_JOIN_CODE_ATTEMPTS: usize = 128;

static JOIN_CODE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct Controllers {
    inner: Mutex<ControllerState>,
}

#[derive(Default)]
struct ControllerState {
    code_to_host: HashMap<String, HostRegistration>,
    host_to_code: HashMap<String, String>,
    controller_to_host: HashMap<String, ControllerRoute>,
}

struct HostRegistration {
    host_client_id: String,
    worker_id: String,
    expires_at: Instant,
}

#[derive(Clone)]
struct ControllerRoute {
    host_client_id: String,
    worker_id: String,
}

pub struct ControllerJoinTarget {
    pub host_client_id: String,
    pub worker_id: String,
}

pub struct ControllerCleanup {
    pub notify_host: Option<String>,
    pub notify_controllers: Vec<String>,
    pub worker_terminations: Vec<(String, String)>,
}

impl Controllers {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ControllerState::default()),
        }
    }

    pub async fn register_host(&self, host_client_id: &str, worker_id: &str) -> String {
        let mut state = self.inner.lock().await;
        state.prune_expired();

        if let Some(existing_code) = state.host_to_code.get(host_client_id).cloned() {
            let refreshed = if let Some(registration) = state.code_to_host.get_mut(&existing_code) {
                registration.worker_id = worker_id.to_string();
                registration.expires_at = Instant::now() + JOIN_CODE_TTL;
                true
            } else {
                false
            };

            if refreshed {
                state.refresh_controller_routes(host_client_id, worker_id);
                return existing_code;
            }
            state.host_to_code.remove(host_client_id);
        }

        let code = state.next_available_code();
        state.code_to_host.insert(
            code.clone(),
            HostRegistration {
                host_client_id: host_client_id.to_string(),
                worker_id: worker_id.to_string(),
                expires_at: Instant::now() + JOIN_CODE_TTL,
            },
        );
        state
            .host_to_code
            .insert(host_client_id.to_string(), code.clone());

        state.refresh_controller_routes(host_client_id, worker_id);
        code
    }

    pub async fn join(
        &self,
        controller_client_id: &str,
        code: &str,
    ) -> Result<ControllerJoinTarget, &'static str> {
        let normalized = code.trim().to_uppercase();
        if normalized.is_empty() {
            return Err("missing-code");
        }

        let mut state = self.inner.lock().await;
        state.prune_expired();

        let target = match state.code_to_host.get(&normalized) {
            Some(registration) => ControllerJoinTarget {
                host_client_id: registration.host_client_id.clone(),
                worker_id: registration.worker_id.clone(),
            },
            None => return Err("invalid-code"),
        };

        state.controller_to_host.insert(
            controller_client_id.to_string(),
            ControllerRoute {
                host_client_id: target.host_client_id.clone(),
                worker_id: target.worker_id.clone(),
            },
        );

        Ok(target)
    }

    pub async fn worker_for_input(
        &self,
        controller_client_id: &str,
        host_client_id: &str,
    ) -> Option<String> {
        let state = self.inner.lock().await;
        let route = state.controller_to_host.get(controller_client_id)?;
        (route.host_client_id == host_client_id).then_some(route.worker_id.clone())
    }

    pub async fn cleanup_peer(&self, client_id: &str) -> ControllerCleanup {
        let mut state = self.inner.lock().await;

        if let Some(route) = state.controller_to_host.remove(client_id) {
            return ControllerCleanup {
                notify_host: Some(route.host_client_id),
                notify_controllers: Vec::new(),
                worker_terminations: vec![(route.worker_id, client_id.to_string())],
            };
        }

        if let Some(code) = state.host_to_code.remove(client_id) {
            state.code_to_host.remove(&code);
        }

        let controller_ids: Vec<String> = state
            .controller_to_host
            .iter()
            .filter_map(|(controller_id, route)| {
                (route.host_client_id == client_id).then_some(controller_id.clone())
            })
            .collect();

        let mut worker_terminations = Vec::new();
        for controller_id in &controller_ids {
            if let Some(route) = state.controller_to_host.remove(controller_id) {
                worker_terminations.push((route.worker_id, controller_id.clone()));
            }
        }

        ControllerCleanup {
            notify_host: None,
            notify_controllers: controller_ids,
            worker_terminations,
        }
    }
}

impl ControllerState {
    fn refresh_controller_routes(&mut self, host_client_id: &str, worker_id: &str) {
        let worker_id = worker_id.to_string();
        for route in self.controller_to_host.values_mut() {
            if route.host_client_id == host_client_id {
                route.worker_id = worker_id.clone();
            }
        }
    }

    fn prune_expired(&mut self) {
        let now = Instant::now();
        let expired_codes: Vec<String> = self
            .code_to_host
            .iter()
            .filter_map(|(code, registration)| (registration.expires_at <= now).then_some(code.clone()))
            .collect();

        for code in expired_codes {
            if let Some(registration) = self.code_to_host.remove(&code) {
                if self
                    .host_to_code
                    .get(&registration.host_client_id)
                    .is_some_and(|current_code| current_code == &code)
                {
                    self.host_to_code.remove(&registration.host_client_id);
                }
            }
        }
    }

    fn next_available_code(&self) -> String {
        for _ in 0..MAX_JOIN_CODE_ATTEMPTS {
            let code = encode_join_code(next_join_code_seed());
            if !self.code_to_host.contains_key(&code) {
                return code;
            }
        }

        let mut seed = next_join_code_seed();
        loop {
            let code = encode_join_code(seed);
            if !self.code_to_host.contains_key(&code) {
                return code;
            }
            seed = seed.wrapping_add(1);
        }
    }
}

fn next_join_code_seed() -> u64 {
    random_seed_from_os().unwrap_or_else(fallback_join_code_seed)
}

#[cfg(unix)]
fn random_seed_from_os() -> Option<u64> {
    let mut bytes = [0u8; 8];
    let mut file = File::open("/dev/urandom").ok()?;
    file.read_exact(&mut bytes).ok()?;
    Some(u64::from_le_bytes(bytes))
}

#[cfg(not(unix))]
fn random_seed_from_os() -> Option<u64> {
    None
}

fn fallback_join_code_seed() -> u64 {
    let counter = JOIN_CODE_COUNTER.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_nanos())
        .unwrap_or(0);
    mix_seed(counter ^ nanos as u64 ^ (nanos >> 64) as u64)
}

fn mix_seed(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9E37_79B9_7F4A_7C15);
    value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    value ^ (value >> 31)
}

fn encode_join_code(mut value: u64) -> String {
    let mut out = [JOIN_CODE_ALPHABET[0]; JOIN_CODE_LENGTH];
    for idx in (0..JOIN_CODE_LENGTH).rev() {
        let alphabet_index = (value % JOIN_CODE_ALPHABET.len() as u64) as usize;
        out[idx] = JOIN_CODE_ALPHABET[alphabet_index];
        value /= JOIN_CODE_ALPHABET.len() as u64;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn host_registration_updates_controller_worker_routes() {
        let controllers = Controllers::new();
        let host = "host-a";
        let controller = "controller-a";

        let code = controllers.register_host(host, "worker-1").await;
        let target = controllers.join(controller, &code).await.expect("join should succeed");
        assert_eq!(target.host_client_id, host);
        assert_eq!(target.worker_id, "worker-1");
        assert_eq!(
            controllers.worker_for_input(controller, host).await,
            Some("worker-1".to_string())
        );

        let stable_code = controllers.register_host(host, "worker-2").await;
        assert_eq!(stable_code, code);

        assert_eq!(
            controllers.worker_for_input(controller, host).await,
            Some("worker-2".to_string())
        );
    }

    #[tokio::test]
    async fn host_registration_uses_six_character_join_codes() {
        let controllers = Controllers::new();

        let code = controllers.register_host("host-a", "worker-1").await;

        assert_eq!(code.len(), JOIN_CODE_LENGTH);
        assert!(code.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit()));
    }
}
