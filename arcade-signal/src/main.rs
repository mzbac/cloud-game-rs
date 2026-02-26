mod config;
mod controllers;
mod protocol;
mod registry;
mod ws;

use std::sync::Arc;

use axum::routing::get;
use axum::{Json, Router};
use tokio::net::TcpListener;
use tower_http::services::ServeDir;
use tracing::{error, info};

use crate::config::{init_logging, AppConfig};
use crate::ws::{browser_ws, worker_ws, AppState};

#[tokio::main]
async fn main() {
    init_logging();

    let AppConfig {
        addr,
        static_dir,
        auth_token,
        allowed_origins,
        dedupe_rooms_by_game,
    } = AppConfig::from_env();

    if auth_token.is_some() || allowed_origins.is_some() {
        info!(
            auth = auth_token.is_some(),
            allowed_origins = allowed_origins.as_ref().map(|set| set.len()).unwrap_or(0),
            "signal websocket access controls enabled"
        );
    }

    let state = Arc::new(AppState::new(
        auth_token,
        allowed_origins,
        dedupe_rooms_by_game,
    ));
    let app = Router::new()
        .route("/", get(|| async { "arcade rust signaling server".to_string() }))
        .route("/ws", get(browser_ws))
        .route("/wws", get(worker_ws))
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({"status": "ok"})) }),
        )
        .route(
            "/healthz",
            get(|| async { Json(serde_json::json!({"status": "ok"})) }),
        )
        .fallback_service(ServeDir::new(static_dir))
        .with_state(state);

    info!("listening on {}", addr);
    let listener = match TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(err) => {
            error!(error = %err, "failed to bind TCP listener");
            return;
        }
    };

    if let Err(err) = axum::serve(listener, app).await {
        error!(error = %err, "server failed");
    }
}
