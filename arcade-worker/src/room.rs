use bytes::Bytes;
use crossbeam_channel::Sender;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio::sync::Notify;
use tracing::{debug, info, warn};
use webrtc::data_channel::data_channel_state::RTCDataChannelState;
use webrtc::data_channel::RTCDataChannel;
use webrtc::media;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use arcade_signal_protocol::{audio as audio_proto, ids as signal_ids, SignalMessage};
use crate::room_state::{PendingInputs, PlayerSlots};
use crate::video_sender;

const AUDIO_CHANNEL_MAX_BUFFER_BYTES: usize = 128 * 1024;

#[derive(Clone)]
pub(crate) struct InputEvent {
    pub(crate) session_id: String,
    pub(crate) data: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct VideoSample {
    sample: media::Sample,
    is_keyframe: bool,
}

impl VideoSample {
    pub(crate) fn sample(&self) -> &media::Sample {
        &self.sample
    }

    pub(crate) fn is_keyframe(&self) -> bool {
        self.is_keyframe
    }
}

pub(crate) struct VideoSampleQueue {
    capacity: usize,
    closed: AtomicBool,
    buffer: Mutex<VecDeque<Arc<VideoSample>>>,
    notify: Notify,
}

impl VideoSampleQueue {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            closed: AtomicBool::new(false),
            buffer: Mutex::new(VecDeque::new()),
            notify: Notify::new(),
        }
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.notify.notify_waiters();
    }

    pub(crate) fn push(&self, sample: Arc<VideoSample>) {
        if self.closed.load(Ordering::Relaxed) {
            return;
        }

        let mut buffer = match self.buffer.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };

        if buffer.len() >= self.capacity {
            if let Some(front) = buffer.front() {
                if front.is_keyframe && !sample.is_keyframe {
                    return;
                }
            }
            buffer.pop_front();
        }

        buffer.push_back(sample);
        drop(buffer);
        self.notify.notify_one();
    }

    pub(crate) async fn pop(&self) -> Option<Arc<VideoSample>> {
        loop {
            if let Ok(mut buffer) = self.buffer.lock() {
                if let Some(sample) = buffer.pop_front() {
                    return Some(sample);
                }
            }

            if self.closed.load(Ordering::Relaxed) {
                return None;
            }

            self.notify.notified().await;
        }
    }
}

pub(crate) struct Session {
    id: String,
    peer: Arc<RTCPeerConnection>,
    #[allow(dead_code)]
    input_channel: Arc<RTCDataChannel>,
    video_track: Arc<TrackLocalStaticSample>,
    video_queue: Arc<VideoSampleQueue>,
    audio_channel: Arc<RTCDataChannel>,
    player_index: Mutex<Option<usize>>,
}

impl Session {
    pub(crate) fn new(
        id: String,
        peer: Arc<RTCPeerConnection>,
        input_channel: Arc<RTCDataChannel>,
        video_track: Arc<TrackLocalStaticSample>,
        video_queue: Arc<VideoSampleQueue>,
        audio_channel: Arc<RTCDataChannel>,
    ) -> Self {
        Self {
            id,
            peer,
            input_channel,
            video_track,
            video_queue,
            audio_channel,
            player_index: Mutex::new(None),
        }
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn peer(&self) -> &Arc<RTCPeerConnection> {
        &self.peer
    }

    pub(crate) fn video_track(&self) -> &Arc<TrackLocalStaticSample> {
        &self.video_track
    }

    pub(crate) fn video_queue(&self) -> &Arc<VideoSampleQueue> {
        &self.video_queue
    }

    pub(crate) fn audio_channel(&self) -> &Arc<RTCDataChannel> {
        &self.audio_channel
    }

    pub(crate) fn set_player(&self, idx: Option<usize>) {
        if let Ok(mut slot) = self.player_index.lock() {
            *slot = idx;
        }
    }
}

#[derive(Clone)]
pub(crate) struct Room {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    session_count: Arc<AtomicUsize>,
    player_slots: Arc<Mutex<PlayerSlots>>,
    pending_inputs: Arc<Mutex<PendingInputs>>,
    keyframe_refresh: Arc<AtomicBool>,
    force_idr: Arc<AtomicBool>,
    signal_tx: mpsc::UnboundedSender<SignalMessage>,
    worker_handle: Handle,
    audio_sample_rate: Arc<AtomicU32>,
}

impl Room {
    pub(crate) fn new(signal_tx: mpsc::UnboundedSender<SignalMessage>, worker_handle: Handle) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_count: Arc::new(AtomicUsize::new(0)),
            player_slots: Arc::new(Mutex::new(PlayerSlots::new())),
            pending_inputs: Arc::new(Mutex::new(PendingInputs::default())),
            keyframe_refresh: Arc::new(AtomicBool::new(false)),
            force_idr: Arc::new(AtomicBool::new(false)),
            signal_tx,
            worker_handle,
            audio_sample_rate: Arc::new(AtomicU32::new(48_000)),
        }
    }

    pub(crate) fn has_video_sessions(&self) -> bool {
        self.session_count.load(Ordering::Relaxed) > 0
    }

    pub(crate) fn request_encoder_refresh(&self) {
        self.keyframe_refresh.store(true, Ordering::Relaxed);
    }

    pub(crate) fn request_idr(&self) {
        self.force_idr.store(true, Ordering::Relaxed);
    }

    pub(crate) fn with_session(&self, session_id: &str) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(session_id).cloned())
    }

    pub(crate) fn video_sessions(&self) -> Vec<Arc<Session>> {
        if !self.has_video_sessions() {
            return Vec::new();
        }

        self.sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect())
            .unwrap_or_default()
    }

    pub(crate) fn player_index_for_session(&self, session_id: &str) -> Option<usize> {
        self.player_slots
            .lock()
            .ok()
            .and_then(|slots| slots.slot_for(session_id))
    }

    pub(crate) fn register_session(&self, session_id: String, session: Arc<Session>) -> bool {
        let mut sessions = match self.sessions.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        if sessions.contains_key(&session_id) {
            false
        } else {
            sessions.insert(session_id, session);
            self.session_count.fetch_add(1, Ordering::Relaxed);
            true
        }
    }

    pub(crate) fn join_room(&self, session_id: &str) -> Option<usize> {
        let had_assignment = self.player_index_for_session(session_id).is_some();
        let player_slot = self.assign_player_slot(session_id);
        if !had_assignment {
            self.request_encoder_refresh();
        }
        player_slot
    }

    pub(crate) fn ensure_session_joined(&self, session_id: &str) -> Option<usize> {
        if let Some(existing_slot) = self.player_index_for_session(session_id) {
            return Some(existing_slot);
        }
        self.join_room(session_id)
    }

    pub(crate) fn take_keyframe_refresh(&self) -> bool {
        self.keyframe_refresh.swap(false, Ordering::Relaxed)
    }

    pub(crate) fn take_force_idr(&self) -> bool {
        self.force_idr.swap(false, Ordering::Relaxed)
    }

    pub(crate) fn assign_player_slot(&self, session_id: &str) -> Option<usize> {
        let mut slots = self.player_slots.lock().ok()?;

        let (player_slot, is_new) = slots.assign(session_id);
        if let Some(slot) = player_slot {
            if let Some(session) = self.with_session(session_id) {
                session.set_player(Some(slot));
            }
            if is_new {
                info!(session_id, slot, "assigned player slot");
            } else {
                return Some(slot);
            }
        } else {
            if let Some(session) = self.with_session(session_id) {
                session.set_player(None);
            }
        }

        let count = slots.count();
        self.send_player_count_update(count);
        player_slot
    }

    pub(crate) fn unregister_session(&self, session_id: &str) -> Option<Arc<Session>> {
        let removed = {
            let mut sessions = self.sessions.lock().ok()?;
            sessions.remove(session_id)
        };
        if removed.is_none() {
            return None;
        }
        self.session_count.fetch_sub(1, Ordering::Relaxed);

        if let Some(session) = &removed {
            session.video_queue().close();
        }

        let mut count_changed = false;
        if let Ok(mut slots) = self.player_slots.lock() {
            if slots.release(session_id) {
                count_changed = true;
            }
            if let Some(session) = &removed {
                session.set_player(None);
            }
        }

        if count_changed {
            let count = self
                .player_slots
                .lock()
                .map(|slots| slots.count())
                .unwrap_or(0);
            self.send_player_count_update(count);
        }

        removed
    }

    pub(crate) fn release_input_source(&self, session_id: &str) -> bool {
        if let Ok(mut pending) = self.pending_inputs.lock() {
            pending.drain(session_id);
        }

        let released = self
            .player_slots
            .lock()
            .ok()
            .is_some_and(|mut slots| slots.release(session_id));

        if released {
            let count = self
                .player_slots
                .lock()
                .map(|slots| slots.count())
                .unwrap_or(0);
            self.send_player_count_update(count);
        }

        released
    }

    pub(crate) fn queue_pending_input(&self, session_id: &str, payload: Vec<u8>) {
        let mut pending = match self.pending_inputs.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        pending.queue(session_id, payload);
    }

    pub(crate) fn drain_pending_inputs(&self, session_id: &str) -> Vec<Vec<u8>> {
        let mut pending = match self.pending_inputs.lock() {
            Ok(guard) => guard,
            Err(_) => return Vec::new(),
        };
        pending.drain(session_id)
    }

    pub(crate) fn flush_pending_inputs_to_sender(
        &self,
        session_id: &str,
        input_sender: &Sender<InputEvent>,
    ) -> usize {
        let pending = self.drain_pending_inputs(session_id);
        if pending.is_empty() {
            return 0;
        }

        let mut sent = 0usize;
        for payload in pending {
            if input_sender
                .send(InputEvent {
                    session_id: session_id.to_string(),
                    data: payload,
                })
                .is_err()
            {
                warn!(session_id, "failed to send queued input");
                break;
            }
            sent = sent.saturating_add(1);
        }
        sent
    }

    pub(crate) fn buffer_or_send_input(
        &self,
        session_id: &str,
        payload: Vec<u8>,
        input_sender: &Sender<InputEvent>,
        source: &str,
    ) {
        let already_assigned = self.player_index_for_session(session_id).is_some();
        let slot = self.ensure_session_joined(session_id);
        if slot.is_none() {
            let players = self
                .player_slots
                .lock()
                .map(|slots| slots.count())
                .unwrap_or(0);
            self.queue_pending_input(session_id, payload);
            debug!(
                session_id,
                source, players, "queued input for unassigned session"
            );
            return;
        }
        let slot = slot.unwrap_or_default();

        if !already_assigned {
            let flushed = self.flush_pending_inputs_to_sender(session_id, input_sender);
            debug!(session_id, slot, flushed, "flushed pending inputs");
        }

        if let Err(err) = input_sender.send(InputEvent {
            session_id: session_id.to_string(),
            data: payload,
        }) {
            warn!(session_id, slot, source, error = %err, "failed to enqueue input");
        }
    }

    pub(crate) fn send_player_count_update(&self, count: usize) {
        let _ = self.signal_tx.send(SignalMessage::with_payload(
            signal_ids::UPDATE_PLAYER_COUNT,
            None,
            Some(count.to_string()),
        ));
    }

    pub(crate) fn broadcast_game_info(&self, game_name: String) {
        let _ = self.signal_tx.send(SignalMessage::with_payload(
            signal_ids::GAME_INFO,
            None,
            Some(game_name),
        ));
    }

    pub(crate) fn broadcast_video_frame(
        &self,
        payload: Bytes,
        sample_duration_ms: u64,
        packet_timestamp: u32,
    ) {
        if !self.has_video_sessions() {
            return;
        }

        let sessions = self.video_sessions();
        if sessions.is_empty() {
            return;
        }

        let duration = Duration::from_millis(sample_duration_ms.max(1));
        let timestamp = SystemTime::now();
        let is_keyframe = video_sender::h264_contains_idr(payload.as_ref());

        for session in sessions {
            if session.video_track().id().is_empty() {
                continue;
            }

            let sample = media::Sample {
                data: payload.clone(),
                duration,
                packet_timestamp,
                timestamp,
                ..Default::default()
            };

            // Favor low latency over buffering; if a client falls behind drop older queued frames.
            session.video_queue().push(Arc::new(VideoSample {
                sample,
                is_keyframe,
            }));
        }
    }

    pub(crate) fn broadcast_audio_frame(&self, encoded: &str) {
        if !self.has_video_sessions() {
            return;
        }

        let sessions = self.video_sessions();
        if sessions.is_empty() {
            return;
        }

        let sample_rate = self.audio_sample_rate.load(Ordering::Relaxed);
        let payload = format!(
            "{}|v={}|sr={sample_rate}|ch={}|{encoded}",
            audio_proto::KIND,
            audio_proto::VERSION,
            audio_proto::CHANNELS
        );
        for session in sessions {
            let channel = session.audio_channel().clone();
            let payload = payload.clone();
            self.worker_handle.spawn(async move {
                if channel.ready_state() != RTCDataChannelState::Open {
                    return;
                }
                let buffered = channel.buffered_amount().await;
                if buffered > AUDIO_CHANNEL_MAX_BUFFER_BYTES {
                    return;
                }
                let _ = channel.send_text(payload).await;
            });
        }
    }

    pub(crate) fn set_audio_sample_rate(&self, sample_rate: f64) {
        let rate = if sample_rate > 0.0 {
            sample_rate as u32
        } else {
            48_000
        };
        self.audio_sample_rate.store(rate, Ordering::Relaxed);
    }

    pub(crate) fn audio_sample_rate(&self) -> u32 {
        self.audio_sample_rate.load(Ordering::Relaxed)
    }
}
