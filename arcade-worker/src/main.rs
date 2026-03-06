use crossbeam_channel::{unbounded, TrySendError};
use std::env;
use std::sync::Arc;
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use arcade_signal_protocol::SignalMessage;
use worker::{AudioFrame, Core, CoreCallbacks, VideoFrame};

mod audio_sender;
mod emulator_thread;
mod game_config;
mod health;
mod room;
mod room_state;
mod signal_client;
mod url_utils;
mod video_sender;
mod webrtc_session;

const EMULATOR_DEFAULT_FPS: f64 = 60.0;
const VIDEO_FRAME_QUEUE_CAPACITY: usize = 24;

fn init_logging() {
    let level = env::var("WORKER_LOG_LEVEL").unwrap_or_else(|_| "info".to_string());
    let filter = EnvFilter::try_new(&level).unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

#[tokio::main]
async fn main() {
    init_logging();
    let bind_host = env::var("WORKER_HEALTH_ADDR").unwrap_or_else(|_| ":8081".to_string());
    health::spawn_health_server(health::parse_port(&bind_host));

    let game_path = match game_config::resolve_game_path() {
        Ok(path) => path,
        Err(err) => {
            error!(error = %err, "game path resolution failed");
            std::process::exit(1);
        }
    };
    let profile = game_config::profile_for_game(&game_path);
    info!(game = %game_path.display(), core = %profile.core, "worker starting");

    let (signal_tx, signal_rx) = mpsc::unbounded_channel::<SignalMessage>();
    let room = Arc::new(room::Room::new(signal_tx.clone(), Handle::current()));

    let (input_sender, input_receiver) = unbounded::<room::InputEvent>();
    let (frame_sender, frame_receiver) =
        crossbeam_channel::bounded::<VideoFrame>(VIDEO_FRAME_QUEUE_CAPACITY);
    let (audio_sender, audio_receiver) = unbounded::<AudioFrame>();

    let mut core = match Core::load_library(&profile.core).and_then(|mut core| {
        let callbacks = CoreCallbacks {
            environment: None,
            video_refresh: None,
            input_poll: None,
            input_state: None,
            audio_sample: None,
            audio_sample_batch: None,
            should_emit_video: Some({
                let room = room.clone();
                let frame_receiver = frame_receiver.clone();
                Arc::new(move || {
                    room.has_video_sessions() && frame_receiver.len() < VIDEO_FRAME_QUEUE_CAPACITY
                })
            }),
            on_video_frame: Some({
                let frame_sender = frame_sender.clone();
                let frame_receiver = frame_receiver.clone();
                let room = room.clone();
                Arc::new(move |frame: VideoFrame| {
                    if !room.has_video_sessions() {
                        return;
                    }
                    match frame_sender.try_send(frame) {
                        Ok(_) => {}
                        Err(TrySendError::Disconnected(_)) => {}
                        Err(TrySendError::Full(frame)) => {
                            let _ = frame_receiver.try_recv();
                            let _ = frame_sender.try_send(frame);
                        }
                    }
                })
            }),
            on_audio_frame: Some(Arc::new(move |frame: AudioFrame| {
                let _ = audio_sender.try_send(frame);
            })),
        };
        core.initialize(Some(callbacks)).map(|_| core)
    }) {
        Ok(core) => core,
        Err(err) => {
            error!(error = %err, "failed to initialize libretro core");
            std::process::exit(1);
        }
    };

    if let Some(cfg) = &profile.config {
        core = core.with_config(cfg);
    }

    let metadata = match core.load_game(&game_path) {
        Ok(metadata) => metadata,
        Err(err) => {
            error!(game = %game_path.display(), error = %err, "failed to load game");
            std::process::exit(1);
        }
    };
    room.set_audio_sample_rate(metadata.timing.sample_rate);

    let fps = EMULATOR_DEFAULT_FPS;

    info!(game = %game_path.display(), core = %profile.core, "emulator initialized");

    let game_name = game_config::resolve_game_name(&game_path);
    room.broadcast_game_info(game_name);

    emulator_thread::spawn_emulator_thread(core, fps, input_receiver, room.clone());
    video_sender::spawn_frame_sender(frame_receiver, room.clone());
    audio_sender::spawn_audio_sender(audio_receiver, room.clone());

    let signal_url = resolve_signal_url();
    signal_client::run_signal_client(signal_url, signal_rx, room, input_sender).await;
}

fn resolve_signal_url() -> String {
    let base_url =
        env::var("WORKER_SIGNAL_URL").unwrap_or_else(|_| "ws://signal:8000/wws".to_string());
    let token = env::var("WORKER_SIGNAL_TOKEN")
        .ok()
        .or_else(|| env::var("SIGNAL_AUTH_TOKEN").ok())
        .and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then_some(trimmed.to_string())
        });

    url_utils::append_query_param(base_url, "token", token.as_deref())
}

#[cfg(test)]
mod main_tests;
