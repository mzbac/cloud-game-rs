use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use crossbeam_channel::Receiver;
use std::collections::VecDeque;
use std::sync::Arc;
use std::thread;

use worker::AudioFrame;

use crate::room::Room;

const AUDIO_FRAME_MS: u64 = 20;

pub(crate) fn spawn_audio_sender(audio_receiver: Receiver<AudioFrame>, room: Arc<Room>) {
    thread::spawn(move || {
        let mut pending: VecDeque<i16> = VecDeque::new();
        let mut payload_bytes: Vec<u8> = Vec::new();
        while let Ok(frame) = audio_receiver.recv() {
            let samples = frame.samples();
            if samples.is_empty() {
                continue;
            }
            if (samples.len() & 1) == 1 {
                continue;
            }

            pending.extend(samples.iter().copied());
            let sample_rate = room.audio_sample_rate().max(1);
            let required = (((sample_rate as f64) * (AUDIO_FRAME_MS as f64) / 1000.0)
                .ceil()
                .max(1.0) as usize)
                .saturating_mul(2);
            if required == 0 {
                continue;
            }
            while pending.len() >= required {
                payload_bytes.clear();
                payload_bytes.reserve(required.saturating_mul(2));
                for _ in 0..required {
                    if let Some(sample) = pending.pop_front() {
                        payload_bytes.extend_from_slice(&sample.to_le_bytes());
                    }
                }
                let encoded = BASE64_STANDARD.encode(&payload_bytes);
                room.broadcast_audio_frame(&encoded);
            }
        }
    });
}
