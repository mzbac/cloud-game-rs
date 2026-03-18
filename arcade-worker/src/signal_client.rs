use arcade_signal_protocol::SignalMessage;
use crossbeam_channel::Sender;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

use crate::room::{InputEvent, Room};
use crate::signal_router::SignalRouter;
use crate::url_utils;

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

    let mut router = SignalRouter::new(room, outbound_tx.clone(), input_sender);
    while let Some(Ok(msg)) = reader.next().await {
        match msg {
            Message::Text(text) => match serde_json::from_str::<SignalMessage>(&text) {
                Ok(req) => router.handle_message(req).await,
                Err(err) => warn!(error = %err, "invalid signaling payload"),
            },
            Message::Close(_) => break,
            _ => {}
        }
    }
}
