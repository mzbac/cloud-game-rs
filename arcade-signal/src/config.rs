use std::collections::HashSet;
use std::env;
use std::net::SocketAddr;

use tracing::warn;
use tracing_subscriber::{fmt, EnvFilter};

pub struct AppConfig {
    pub addr: SocketAddr,
    pub static_dir: String,
    pub auth_token: Option<String>,
    pub allowed_origins: Option<HashSet<String>>,
    pub dedupe_rooms_by_game: bool,
}

pub fn init_logging() {
    let level = env::var("SIGNAL_LOG_LEVEL").unwrap_or_else(|_| "info".to_string());
    let filter = EnvFilter::try_new(&level).unwrap_or_else(|_| EnvFilter::new("info"));

    fmt().with_env_filter(filter).init();
}

impl AppConfig {
    pub fn from_env() -> Self {
        let raw_addr = env::var("SIGNAL_ADDR")
            .or_else(|_| env::var("PORT"))
            .unwrap_or_else(|_| ":8000".to_string());
        let addr = parse_socket_addr(&raw_addr);
        let static_dir = env::var("SIGNAL_STATIC_DIR").unwrap_or_else(|_| "./static".to_string());
        let auth_token = env::var("SIGNAL_AUTH_TOKEN").ok().and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then_some(trimmed.to_string())
        });
        let allowed_origins = parse_allowed_origins(env::var("SIGNAL_ALLOWED_ORIGINS").ok());
        let dedupe_rooms_by_game = parse_env_flag("SIGNAL_DEDUP_ROOMS_BY_GAME");

        Self {
            addr,
            static_dir,
            auth_token,
            allowed_origins,
            dedupe_rooms_by_game,
        }
    }
}

fn parse_socket_addr(raw: &str) -> SocketAddr {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return SocketAddr::from(([0, 0, 0, 0], 8000));
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let without_scheme = trimmed
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap_or_default();
        return parse_socket_addr(without_scheme);
    }

    if trimmed.starts_with(':') || !trimmed.contains(':') {
        let with_host = if trimmed.starts_with(':') {
            format!("0.0.0.0{trimmed}")
        } else {
            format!("0.0.0.0:{trimmed}")
        };

        if let Ok(addr) = with_host.parse::<SocketAddr>() {
            return addr;
        }

        warn!(
            "invalid SIGNAL_ADDR value '{}', falling back to 0.0.0.0:8000",
            trimmed
        );
        return SocketAddr::from(([0, 0, 0, 0], 8000));
    }

    if let Ok(addr) = trimmed.parse::<SocketAddr>() {
        return addr;
    }

    warn!(
        "invalid SIGNAL_ADDR/PUBLIC_ADDR value '{}', falling back to 0.0.0.0:8000",
        raw
    );
    SocketAddr::from(([0, 0, 0, 0], 8000))
}

fn parse_allowed_origins(raw: Option<String>) -> Option<HashSet<String>> {
    let raw = raw?;
    let mut set = HashSet::new();
    for entry in raw.split(|c: char| c == ',' || c.is_whitespace()) {
        let trimmed = entry.trim();
        if !trimmed.is_empty() {
            set.insert(trimmed.to_string());
        }
    }
    (!set.is_empty()).then_some(set)
}

fn parse_env_flag(name: &str) -> bool {
    env::var(name)
        .ok()
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some_and(|value| {
            value == "1"
                || value.eq_ignore_ascii_case("true")
                || value.eq_ignore_ascii_case("yes")
                || value.eq_ignore_ascii_case("on")
        })
}
