use bytes::Bytes;
use crossbeam_channel::Receiver;
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, IntraFramePeriod, RateControlMode,
};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tracing::{debug, error, warn};
use worker::{RetroPixelFormat, VideoFrame};

use crate::room::{Room, VideoPressureSnapshot, VideoSenderUpdate};

pub(crate) const VIDEO_RTP_CLOCK_RATE: u32 = 90_000;
// WebKit/Safari rejects unconstrained Baseline (42001f) in SDP negotiation; use Constrained Baseline.
pub(crate) const H264_SDP_FMTP_LINE: &str =
    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";

const VIDEO_WIDTH_LIMIT: u32 = 960;
const VIDEO_HEIGHT_LIMIT: u32 = 540;
const VIDEO_WIDTH_LIMIT_MIN: u32 = 704;
const VIDEO_HEIGHT_LIMIT_MIN: u32 = 416;
const VIDEO_WIDTH_LIMIT_STEP: u32 = 80;
const VIDEO_HEIGHT_LIMIT_STEP: u32 = 45;
const VIDEO_FRAME_INTERVAL_MS: u64 = 16;
const VIDEO_FRAME_INTERVAL_MS_MIN: u64 = 16;
const VIDEO_FRAME_INTERVAL_MS_MAX: u64 = 50;
const VIDEO_FRAME_INTERVAL_STEP_MS: u64 = 4;
const VIDEO_SCALE_FALLBACK_DISABLE_AFTER: u32 = 1;
const VIDEO_ENCODER_EMPTY_RETRY_THRESHOLD: u32 = 360000;
const VIDEO_STARTUP_ENCODE_RETRY_LIMIT: u8 = 3;
/// Avoid server-side upscaling; browsers can scale cheaply.
const VIDEO_UPSCALE_LIMIT: f32 = 1.0;
const VIDEO_ENCODER_REFRESH_FRAMES: u64 = 200;
const VIDEO_TARGET_MAX_PAYLOAD_BYTES: usize = 768 * 1024;
const H264_LEVEL_3_1_MBS_PER_SEC: u64 = 108_000;
const VIDEO_ENCODER_BITS_PER_PIXEL_PER_FRAME: u64 = 8;
const VIDEO_ENCODER_MIN_BITRATE_BPS: u32 = 500_000;
const VIDEO_ENCODER_MAX_BITRATE_BPS: u32 = 4_000_000;
/// Minimum valid H264 payload size. Must pass all payloads to retain WebRTC packet pacing (e.g. empty P-frames are 12-13 bytes).
const VIDEO_ENCODER_MIN_PAYLOAD_BYTES: usize = 1;
const VIDEO_QUEUE_PRESSURE_HIGH_WATERMARK: usize = 2;

#[derive(Clone, Copy)]
struct VideoProfile {
    target_width: u32,
    target_height: u32,
    frame_interval_ms: u64,
}

impl VideoProfile {
    fn default() -> Self {
        Self {
            target_width: VIDEO_WIDTH_LIMIT,
            target_height: VIDEO_HEIGHT_LIMIT,
            frame_interval_ms: VIDEO_FRAME_INTERVAL_MS,
        }
    }
}

fn degrade_video_profile(profile: &mut VideoProfile) {
    profile.target_width =
        (profile.target_width.saturating_sub(VIDEO_WIDTH_LIMIT_STEP)).max(VIDEO_WIDTH_LIMIT_MIN);
    profile.target_height = (profile
        .target_height
        .saturating_sub(VIDEO_HEIGHT_LIMIT_STEP))
    .max(VIDEO_HEIGHT_LIMIT_MIN);
    profile.frame_interval_ms = (profile
        .frame_interval_ms
        .saturating_add(VIDEO_FRAME_INTERVAL_STEP_MS))
    .min(VIDEO_FRAME_INTERVAL_MS_MAX);
}

fn restore_video_profile(profile: &mut VideoProfile) {
    profile.target_width = (profile.target_width + VIDEO_WIDTH_LIMIT_STEP).min(VIDEO_WIDTH_LIMIT);
    profile.target_height =
        (profile.target_height + VIDEO_HEIGHT_LIMIT_STEP).min(VIDEO_HEIGHT_LIMIT);
    profile.frame_interval_ms = profile
        .frame_interval_ms
        .saturating_sub(VIDEO_FRAME_INTERVAL_STEP_MS)
        .max(VIDEO_FRAME_INTERVAL_MS_MIN);
}

fn is_min_video_profile(profile: &VideoProfile) -> bool {
    profile.target_width == VIDEO_WIDTH_LIMIT_MIN
        && profile.target_height == VIDEO_HEIGHT_LIMIT_MIN
        && profile.frame_interval_ms == VIDEO_FRAME_INTERVAL_MS_MAX
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EncodeSettings {
    width: u32,
    height: u32,
    frame_interval_ms: u64,
}

#[derive(Debug)]
struct EncodedFrame {
    payload: Vec<u8>,
    is_keyframe: bool,
}

pub(crate) fn h264_contains_idr(bitstream: &[u8]) -> bool {
    if bitstream.is_empty() {
        return false;
    }

    let mut i = 0usize;
    let mut found_start_code = false;
    while i + 3 <= bitstream.len() {
        let start_code_len = if bitstream[i..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if bitstream[i..].starts_with(&[0, 0, 1]) {
            3
        } else {
            i = i.saturating_add(1);
            continue;
        };

        found_start_code = true;
        let nal_start = i + start_code_len;
        if nal_start >= bitstream.len() {
            break;
        }

        let nal_type = bitstream[nal_start] & 0x1f;
        if nal_type == 5 {
            return true;
        }

        i = nal_start.saturating_add(1);
    }

    if found_start_code {
        return false;
    }

    // AVCC (length-prefixed) fallback: 4-byte big-endian length + NAL bytes
    let mut i = 0usize;
    while i + 4 <= bitstream.len() {
        let len = u32::from_be_bytes([
            bitstream[i],
            bitstream[i + 1],
            bitstream[i + 2],
            bitstream[i + 3],
        ]) as usize;
        i = i.saturating_add(4);
        if len == 0 {
            continue;
        }
        if i + len > bitstream.len() {
            break;
        }

        let nal_type = bitstream[i] & 0x1f;
        if nal_type == 5 {
            return true;
        }

        i = i.saturating_add(len);
    }

    false
}

pub(crate) fn spawn_frame_sender(frame_receiver: Receiver<VideoFrame>, room: Arc<Room>) {
    thread::spawn(move || {
        let mut state = match FrameSenderState::new() {
            Some(value) => value,
            None => return,
        };

        while let Ok(mut frame) = frame_receiver.recv() {
            while let Ok(new_frame) = frame_receiver.try_recv() {
                frame = new_frame;
            }

            let width = frame.width();
            let height = frame.height();
            if width == 0 || height == 0 {
                continue;
            }

            if !room.has_video_sessions() {
                state.had_active_session = false;
                continue;
            }

            let sender_update = room.next_video_sender_update();
            state.handle_session_transitions(sender_update, width, height);
            state.handle_frame(frame, &room, sender_update.pressure);
        }
    });
}

struct FrameSenderState {
    profile: VideoProfile,
    encoder: Encoder,
    last_sent: Instant,
    stable_frames: u64,
    packet_timestamp: u32,
    startup_encode_failures: u8,
    first_payload_sent: bool,
    had_active_session: bool,
    encoder_frames_since_refresh: u64,
    scaled_failures_for_source: u32,
    last_encode_settings: Option<EncodeSettings>,
    encode_empty_streak: u32,
    rgba_scratch: Vec<u8>,
    scaled_scratch: Vec<u8>,
    disable_scaled_for_source: bool,
    last_source_dims: (u32, u32),
}

impl FrameSenderState {
    fn new() -> Option<Self> {
        let profile = VideoProfile::default();
        let encoder = match new_encoder_for_settings(EncodeSettings {
            width: VIDEO_WIDTH_LIMIT,
            height: VIDEO_HEIGHT_LIMIT,
            frame_interval_ms: profile.frame_interval_ms,
        }) {
            Some(value) => value,
            None => {
                error!(
                    width = VIDEO_WIDTH_LIMIT,
                    height = VIDEO_HEIGHT_LIMIT,
                    "openh264 encoder init failed for initial profile"
                );
                return None;
            }
        };
        let last_sent = Instant::now()
            .checked_sub(Duration::from_millis(profile.frame_interval_ms))
            .unwrap_or_else(Instant::now);

        Some(Self {
            profile,
            encoder,
            last_sent,
            stable_frames: 0,
            packet_timestamp: 0,
            startup_encode_failures: 0,
            first_payload_sent: false,
            had_active_session: false,
            encoder_frames_since_refresh: 0,
            scaled_failures_for_source: 0,
            last_encode_settings: None,
            encode_empty_streak: 0,
            rgba_scratch: Vec::new(),
            scaled_scratch: Vec::new(),
            disable_scaled_for_source: false,
            last_source_dims: (0, 0),
        })
    }

    fn reset_for_active_session(&mut self) {
        self.had_active_session = true;
        self.profile = VideoProfile::default();
        self.startup_encode_failures = 0;
        self.first_payload_sent = false;
        self.stable_frames = 0;
        self.packet_timestamp = 0;
        self.disable_scaled_for_source = false;
        self.scaled_failures_for_source = 0;
        self.encode_empty_streak = 0;
        self.last_encode_settings = None;
        self.encoder_frames_since_refresh = 0;
        self.encoder.force_intra_frame();
    }

    fn handle_session_transitions(
        &mut self,
        sender_update: VideoSenderUpdate,
        width: u32,
        height: u32,
    ) {
        if !self.had_active_session {
            self.reset_for_active_session();
            return;
        }

        if sender_update.refresh_encoder {
            let refresh_settings = EncodeSettings {
                width: self.profile.target_width,
                height: self.profile.target_height,
                frame_interval_ms: self.profile.frame_interval_ms,
            };
            if let Some(recover_encoder) = new_encoder_for_settings(refresh_settings) {
                self.encoder = recover_encoder;
                self.last_encode_settings = None;
                debug!("refreshed H264 encoder after session join");
            } else {
                warn!("failed to refresh H264 encoder; retaining current encoder");
            }
            self.encoder.force_intra_frame();
            self.first_payload_sent = false;
            self.stable_frames = 0;
            self.startup_encode_failures = 0;
            self.scaled_failures_for_source = 0;
            self.disable_scaled_for_source = false;
            self.encode_empty_streak = 0;
            self.encoder_frames_since_refresh = 0;
        }

        if sender_update.force_idr {
            self.encoder.force_intra_frame();
        }

        if (width, height) != self.last_source_dims {
            self.last_source_dims = (width, height);
            self.scaled_failures_for_source = 0;
            self.encode_empty_streak = 0;
            self.disable_scaled_for_source = false;
        }
    }

    fn handle_frame(&mut self, frame: VideoFrame, room: &Room, pressure: VideoPressureSnapshot) {
        let now = Instant::now();
        let mut frame = frame;
        if pressure.congested_events > 0 || pressure.dropped_frames > 0 {
            if !is_min_video_profile(&self.profile) {
                degrade_video_profile(&mut self.profile);
            }
            self.stable_frames = 0;
        } else if pressure.max_queue_len >= VIDEO_QUEUE_PRESSURE_HIGH_WATERMARK {
            self.profile.frame_interval_ms = self
                .profile
                .frame_interval_ms
                .saturating_add(VIDEO_FRAME_INTERVAL_STEP_MS)
                .min(VIDEO_FRAME_INTERVAL_MS_MAX);
            self.stable_frames = 0;
        }

        let width = frame.width();
        let height = frame.height();
        let (scaled_w, scaled_h) = scale_dimensions(
            width,
            height,
            self.profile.target_width,
            self.profile.target_height,
        );
        let should_attempt_scaled = scaled_w != width || scaled_h != height;
        let (pacing_width, pacing_height) = if should_attempt_scaled {
            (scaled_w, scaled_h)
        } else {
            (width, height)
        };
        let frame_interval_ms = self
            .profile
            .frame_interval_ms
            .max(h264_min_frame_interval_ms(pacing_width, pacing_height));
        if now.duration_since(self.last_sent).as_millis() < u128::from(frame_interval_ms) {
            return;
        }

        let elapsed_ms = now.duration_since(self.last_sent).as_millis();
        let sample_duration_ms = u64::try_from(elapsed_ms)
            .unwrap_or(frame_interval_ms)
            .max(frame_interval_ms)
            .max(1);
        let packet_step = ((VIDEO_RTP_CLOCK_RATE as u128)
            .saturating_mul(sample_duration_ms as u128)
            .saturating_div(1000))
        .max(1) as u32;

        let mut scaled_attempted_this_frame = false;
        let mut scaled_transport_failed = false;
        let allow_scaled = should_attempt_scaled && !self.disable_scaled_for_source;

        if VIDEO_ENCODER_REFRESH_FRAMES > 0
            && self.encoder_frames_since_refresh >= VIDEO_ENCODER_REFRESH_FRAMES
        {
            self.encoder.force_intra_frame();
            self.encoder_frames_since_refresh = 0;
        }

        let mut payload = if allow_scaled {
            match build_video_payload(
                &mut frame,
                &self.profile,
                &mut self.encoder,
                allow_scaled,
                &mut self.last_encode_settings,
                &mut self.encode_empty_streak,
                &mut self.rgba_scratch,
                &mut self.scaled_scratch,
            ) {
                Some((candidate, scaled)) => {
                    scaled_attempted_this_frame = true;
                    if !scaled && should_attempt_scaled {
                        scaled_transport_failed = true;
                    }
                    if scaled {
                        self.scaled_failures_for_source = 0;
                    }
                    Some(candidate)
                }
                None => {
                    scaled_attempted_this_frame = true;
                    scaled_transport_failed = true;
                    None
                }
            }
        } else {
            build_video_payload(
                &mut frame,
                &self.profile,
                &mut self.encoder,
                false,
                &mut self.last_encode_settings,
                &mut self.encode_empty_streak,
                &mut self.rgba_scratch,
                &mut self.scaled_scratch,
            )
            .map(|(candidate, _)| candidate)
        };

        if allow_scaled && scaled_attempted_this_frame && scaled_transport_failed {
            self.scaled_failures_for_source = self.scaled_failures_for_source.saturating_add(1);
            if self.scaled_failures_for_source >= VIDEO_SCALE_FALLBACK_DISABLE_AFTER {
                self.scaled_failures_for_source = 0;
                self.disable_scaled_for_source = true;
            }
        } else if allow_scaled && scaled_attempted_this_frame && !scaled_transport_failed {
            self.scaled_failures_for_source = 0;
            self.disable_scaled_for_source = false;
        }
        if let Some(ref candidate) = payload {
            if candidate.payload.len() > VIDEO_TARGET_MAX_PAYLOAD_BYTES {
                if !is_min_video_profile(&self.profile) {
                    degrade_video_profile(&mut self.profile);
                }
                payload = None;
            }
        } else if !self.first_payload_sent && self.startup_encode_failures < VIDEO_STARTUP_ENCODE_RETRY_LIMIT {
            self.startup_encode_failures = self.startup_encode_failures.saturating_add(1);
        } else if !is_min_video_profile(&self.profile) {
            degrade_video_profile(&mut self.profile);
        }

        let payload = match payload {
            Some(payload) => payload,
            None => return,
        };

        let payload_len = payload.payload.len();
        let is_keyframe = payload.is_keyframe;
        let payload = Bytes::from(payload.payload);

        let frame_timestamp = self.packet_timestamp;
        self.packet_timestamp = self.packet_timestamp.wrapping_add(packet_step);
        self.encoder_frames_since_refresh = self.encoder_frames_since_refresh.saturating_add(1);
        self.first_payload_sent = true;
        room.broadcast_video_frame(payload, sample_duration_ms, frame_timestamp, is_keyframe);
        self.startup_encode_failures = 0;
        self.stable_frames = self.stable_frames.saturating_add(1);
        self.last_sent = now;

        if self.stable_frames.is_multiple_of(120) {
            restore_video_profile(&mut self.profile);
            self.stable_frames = 0;
        }
        if payload_len < VIDEO_TARGET_MAX_PAYLOAD_BYTES / 2 {
            self.profile.frame_interval_ms = self
                .profile
                .frame_interval_ms
                .saturating_sub(VIDEO_FRAME_INTERVAL_STEP_MS)
                .max(VIDEO_FRAME_INTERVAL_MS_MIN);
        }
    }
}

fn build_video_payload(
    frame: &mut VideoFrame,
    profile: &VideoProfile,
    encoder: &mut Encoder,
    allow_scaled: bool,
    last_encode_settings: &mut Option<EncodeSettings>,
    empty_encode_streak: &mut u32,
    rgba_scratch: &mut Vec<u8>,
    scaled_scratch: &mut Vec<u8>,
) -> Option<(EncodedFrame, bool)> {
    let width = frame.width();
    let height = frame.height();
    if width == 0 || height == 0 {
        return None;
    }

    let (target_w, target_h) =
        scale_dimensions(width, height, profile.target_width, profile.target_height);
    let rgba_raw = fill_rgba_buffer_from_frame(frame, rgba_scratch)?;
    let should_scale = allow_scaled && (target_w != width || target_h != height);

    if should_scale {
        if scale_rgba_nearest(
            rgba_raw,
            width,
            height,
            target_w,
            target_h,
            scaled_scratch,
        )
        .is_some()
        {
            if let Some(output) = encode_frame_with_retry(
                encoder,
                target_w,
                target_h,
                profile.frame_interval_ms,
                scaled_scratch.as_slice(),
                last_encode_settings,
                empty_encode_streak,
            ) {
                return Some((output, true));
            }
        }

        if let Some(output) = encode_frame_with_retry(
            encoder,
            width,
            height,
            profile.frame_interval_ms,
            rgba_raw,
            last_encode_settings,
            empty_encode_streak,
        ) {
            return Some((output, false));
        }

        return None;
    }

    if let Some(output) = encode_frame_with_retry(
        encoder,
        width,
        height,
        profile.frame_interval_ms,
        rgba_raw,
        last_encode_settings,
        empty_encode_streak,
    ) {
        return Some((output, false));
    }

    None
}

fn calculate_encoder_bitrate_bps(settings: EncodeSettings) -> u32 {
    let base_bitrate_bps = (settings.width as u64)
        .saturating_mul(settings.height as u64)
        .saturating_mul(VIDEO_ENCODER_BITS_PER_PIXEL_PER_FRAME);
    let paced_bitrate_bps = base_bitrate_bps
        .saturating_mul(VIDEO_FRAME_INTERVAL_MS_MIN)
        .saturating_div(settings.frame_interval_ms.max(VIDEO_FRAME_INTERVAL_MS_MIN));

    paced_bitrate_bps
        .min(u64::from(VIDEO_ENCODER_MAX_BITRATE_BPS))
        .max(u64::from(VIDEO_ENCODER_MIN_BITRATE_BPS)) as u32
}

fn new_encoder_for_settings(settings: EncodeSettings) -> Option<Encoder> {
    if settings.width == 0 || settings.height == 0 {
        return None;
    }

    let bitrate_bps = calculate_encoder_bitrate_bps(settings);

    let config = EncoderConfig::new()
        .bitrate(BitRate::from_bps(bitrate_bps))
        .max_frame_rate(FrameRate::from_hz(60.0))
        .rate_control_mode(RateControlMode::Bitrate)
        .skip_frames(false)
        .complexity(Complexity::Low)
        .adaptive_quantization(false)
        .background_detection(false)
        .intra_frame_period(IntraFramePeriod::from_num_frames(60))
        // Ensure immediate framing for real-time streaming to avoid WebRTC buffering
        .usage_type(openh264::encoder::UsageType::ScreenContentRealTime);

    match Encoder::with_api_config(openh264::OpenH264API::from_source(), config) {
        Ok(encoder) => Some(encoder),
        Err(err) => {
            warn!(
                width = settings.width,
                height = settings.height,
                frame_interval_ms = settings.frame_interval_ms,
                bitrate_bps,
                error = %err,
                "openh264 encoder init failed"
            );
            None
        }
    }
}

fn encode_frame_with_retry(
    encoder: &mut Encoder,
    width: u32,
    height: u32,
    frame_interval_ms: u64,
    rgba_raw: &[u8],
    last_encode_settings: &mut Option<EncodeSettings>,
    empty_encode_streak: &mut u32,
) -> Option<EncodedFrame> {
    let rgba = RgbaSliceU8::new(
        rgba_raw,
        (usize::try_from(width).ok()?, usize::try_from(height).ok()?),
    );
    let yuv = YUVBuffer::from_rgb_source(rgba);

    let encode_once = |encoder: &mut Encoder, yuv: &YUVBuffer| -> Option<EncodedFrame> {
        let mut output = Vec::new();
        match encoder.encode(yuv) {
            Ok(bitstream) => {
                bitstream.write_vec(&mut output);
                (output.len() >= VIDEO_ENCODER_MIN_PAYLOAD_BYTES).then_some(EncodedFrame {
                    is_keyframe: h264_contains_idr(&output),
                    payload: output,
                })
            }
            Err(err) => {
                debug!(width, height, error = ?err, "openh264 encode error");
                None
            }
        }
    };

    let settings = EncodeSettings {
        width,
        height,
        frame_interval_ms,
    };

    let had_encode_settings_reset = if last_encode_settings.is_none()
        || last_encode_settings.map_or(false, |current| current != settings)
    {
        if let Some(new_encoder) = new_encoder_for_settings(settings) {
            *encoder = new_encoder;
            *last_encode_settings = Some(settings);
            *empty_encode_streak = 0;
            true
        } else {
            warn!(width, height, frame_interval_ms, "openh264 encoder reinitialize failed");
            return None;
        }
    } else {
        false
    };

    let mut output = encode_once(encoder, &yuv);
    if output.is_none() && had_encode_settings_reset {
        output = encode_once(encoder, &yuv);
    }

    if let Some(output) = output {
        *empty_encode_streak = 0;
        return Some(output);
    }

    *empty_encode_streak = empty_encode_streak.saturating_add(1);
    if *empty_encode_streak >= VIDEO_ENCODER_EMPTY_RETRY_THRESHOLD {
        if let Some(recovered_encoder) = new_encoder_for_settings(settings) {
            *encoder = recovered_encoder;
            *last_encode_settings = Some(settings);
            if let Some(output) = encode_once(encoder, &yuv) {
                *empty_encode_streak = 0;
                return Some(output);
            }
            *empty_encode_streak = 1;
        }
    }

    None
}

pub(crate) fn fill_rgba_buffer_from_frame<'a>(
    frame: &'a mut VideoFrame,
    out: &'a mut Vec<u8>,
) -> Option<&'a [u8]> {
    let width = frame.width() as usize;
    let height = frame.height() as usize;
    let pitch = frame.pitch();
    if pitch == 0 || width == 0 || height == 0 {
        return None;
    }

    let frame_len = frame.data().len();
    let min_expected = height.checked_mul(pitch)?;
    if frame_len < min_expected {
        warn!(
            format = ?frame.format(),
            width = frame.width(),
            height = frame.height(),
            pitch,
            frame_len,
            min_expected,
            "invalid frame stride"
        );
        return None;
    }

    let out_len = width.checked_mul(height)?.checked_mul(4)?;
    match frame.format() {
        RetroPixelFormat::Xrgb8888 => {
            let expected_row_bytes = width.checked_mul(4)?;
            if pitch == expected_row_bytes {
                let data = frame.data_mut();
                if data.len() < out_len {
                    return None;
                }
                for pixel in data[..out_len].chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                    pixel[3] = 255;
                }
                return Some(&frame.data()[..out_len]);
            }

            out.resize(out_len, 0);
            let data = frame.data();
            for y in 0..height {
                let row_start = y.checked_mul(pitch)?;
                let row_end = row_start.checked_add(expected_row_bytes)?;
                if row_end > frame_len {
                    return None;
                }
                let row = &data[row_start..row_end];
                for x in 0..width {
                    let src_base = x * 4;
                    let dst_base = (y * width + x) * 4;
                    out[dst_base] = row[src_base + 2];
                    out[dst_base + 1] = row[src_base + 1];
                    out[dst_base + 2] = row[src_base];
                    out[dst_base + 3] = 255;
                }
            }
            Some(out.as_slice())
        }
        RetroPixelFormat::Rgb565 => {
            let expected_row_bytes = width.checked_mul(2)?;
            out.resize(out_len, 0);
            let data = frame.data();
            for y in 0..height {
                let row_start = y.checked_mul(pitch)?;
                let row_end = row_start.checked_add(expected_row_bytes)?;
                if row_end > frame_len {
                    return None;
                }
                let row = &data[row_start..row_end];
                for x in 0..width {
                    let src_base = x * 2;
                    let raw = u16::from_le_bytes([row[src_base], row[src_base + 1]]);
                    let r5 = ((raw >> 11) & 0x1f) as u8;
                    let g6 = ((raw >> 5) & 0x3f) as u8;
                    let b5 = (raw & 0x1f) as u8;
                    let r = (r5 << 3) | (r5 >> 2);
                    let g = (g6 << 2) | (g6 >> 4);
                    let b = (b5 << 3) | (b5 >> 2);
                    let dst_base = (y * width + x) * 4;
                    out[dst_base] = r;
                    out[dst_base + 1] = g;
                    out[dst_base + 2] = b;
                    out[dst_base + 3] = 255;
                }
            }
            Some(out.as_slice())
        }
        RetroPixelFormat::Rgb1555 => {
            let expected_row_bytes = width.checked_mul(2)?;
            out.resize(out_len, 0);
            let data = frame.data();
            for y in 0..height {
                let row_start = y.checked_mul(pitch)?;
                let row_end = row_start.checked_add(expected_row_bytes)?;
                if row_end > frame_len {
                    return None;
                }
                let row = &data[row_start..row_end];
                for x in 0..width {
                    let src_base = x * 2;
                    let raw = u16::from_le_bytes([row[src_base], row[src_base + 1]]);
                    let r5 = ((raw >> 10) & 0x1f) as u8;
                    let g5 = ((raw >> 5) & 0x1f) as u8;
                    let b5 = (raw & 0x1f) as u8;
                    let r = (r5 << 3) | (r5 >> 2);
                    let g = (g5 << 3) | (g5 >> 2);
                    let b = (b5 << 3) | (b5 >> 2);
                    let dst_base = (y * width + x) * 4;
                    out[dst_base] = r;
                    out[dst_base + 1] = g;
                    out[dst_base + 2] = b;
                    out[dst_base + 3] = 255;
                }
            }
            Some(out.as_slice())
        }
        RetroPixelFormat::Unknown(format) => {
            warn!(
                format,
                width = frame.width(),
                height = frame.height(),
                pitch,
                bytes = frame_len,
                "unsupported video pixel format"
            );
            None
        }
    }
}

fn scale_dimensions(src_w: u32, src_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let target_width = max_w.max(1);
    let target_height = max_h.max(1);
    let width_scale = target_width as f32 / src_w as f32;
    let height_scale = target_height as f32 / src_h as f32;
    let scale = width_scale
        .min(height_scale)
        .min(VIDEO_UPSCALE_LIMIT)
        .max(0.1);
    let scaled_w = ((src_w as f32 * scale).max(1.0).round() as u32).max(16);
    let scaled_h = ((src_h as f32 * scale).max(1.0).round() as u32).max(16);
    let scaled_w = scaled_w.div_ceil(16) * 16;
    let scaled_h = scaled_h.div_ceil(16) * 16;
    (scaled_w, scaled_h)
}

fn h264_min_frame_interval_ms(width: u32, height: u32) -> u64 {
    if width == 0 || height == 0 {
        return VIDEO_FRAME_INTERVAL_MS_MIN;
    }
    let macroblocks_per_frame = (width.div_ceil(16) as u64) * (height.div_ceil(16) as u64);
    let max_fps = (H264_LEVEL_3_1_MBS_PER_SEC / macroblocks_per_frame.max(1)).max(1);
    let interval_ms = (1000 + max_fps - 1) / max_fps;
    interval_ms.max(VIDEO_FRAME_INTERVAL_MS_MIN)
}

fn scale_rgba_nearest(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    dst: &mut Vec<u8>,
) -> Option<()> {
    let src_w = usize::try_from(src_w).ok()?;
    let src_h = usize::try_from(src_h).ok()?;
    let dst_w = usize::try_from(dst_w).ok()?;
    let dst_h = usize::try_from(dst_h).ok()?;

    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return None;
    }

    let src_stride = src_w.checked_mul(4)?;
    let src_len = src_stride.checked_mul(src_h)?;
    if src.len() < src_len {
        return None;
    }

    let dst_stride = dst_w.checked_mul(4)?;
    let dst_len = dst_stride.checked_mul(dst_h)?;
    dst.resize(dst_len, 0);

    for y in 0..dst_h {
        let src_y = y.saturating_mul(src_h) / dst_h;
        let src_row_start = src_y.saturating_mul(src_stride);
        let src_row_end = src_row_start.saturating_add(src_stride);
        if src_row_end > src.len() {
            return None;
        }
        let src_row = &src[src_row_start..src_row_end];

        let dst_row_start = y.saturating_mul(dst_stride);
        let dst_row_end = dst_row_start.saturating_add(dst_stride);
        if dst_row_end > dst.len() {
            return None;
        }
        let dst_row = &mut dst[dst_row_start..dst_row_end];

        for x in 0..dst_w {
            let src_x = x.saturating_mul(src_w) / dst_w;
            let src_base = src_x.saturating_mul(4);
            let dst_base = x.saturating_mul(4);
            if src_base.saturating_add(4) > src_row.len() || dst_base.saturating_add(4) > dst_row.len() {
                return None;
            }
            dst_row[dst_base..dst_base + 4].copy_from_slice(&src_row[src_base..src_base + 4]);
        }
    }

    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn h264_sdp_fmtp_line_uses_constrained_baseline_profile() {
        assert_eq!(
            H264_SDP_FMTP_LINE,
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
        );
    }

    #[test]
    fn encoder_bitrate_scales_down_with_frame_interval() {
        let fast = calculate_encoder_bitrate_bps(EncodeSettings {
            width: 960,
            height: 540,
            frame_interval_ms: VIDEO_FRAME_INTERVAL_MS_MIN,
        });
        let slow = calculate_encoder_bitrate_bps(EncodeSettings {
            width: 960,
            height: 540,
            frame_interval_ms: VIDEO_FRAME_INTERVAL_MS_MAX,
        });

        assert!(slow < fast);
    }
}
