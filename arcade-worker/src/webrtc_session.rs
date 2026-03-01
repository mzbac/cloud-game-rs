use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use crossbeam_channel::Sender;
use rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtcp::transport_feedbacks::rapid_resynchronization_request::RapidResynchronizationRequest;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecParameters;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::{
    RTCPFeedback, TYPE_RTCP_FB_CCM, TYPE_RTCP_FB_GOOG_REMB, TYPE_RTCP_FB_NACK,
};
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use arcade_signal_protocol::{ids as signal_ids, rtc as rtc_labels, SignalMessage};
use crate::room::{InputEvent, Room, Session, VideoSampleQueue};
use crate::video_sender;

const VIDEO_SESSION_QUEUE_CAPACITY: usize = 3;

pub(crate) async fn apply_answer(peer: &Arc<RTCPeerConnection>, payload: &str) -> Result<(), String> {
    if payload.is_empty() {
        return Ok(());
    }

    if peer.remote_description().await.is_some() {
        debug!("ignoring duplicate remote description");
        return Ok(());
    }

    let raw = BASE64_STANDARD
        .decode(payload)
        .map_err(|err| format!("decode answer payload failed: {err}"))?;
    let raw = match serde_json::from_slice::<Value>(&raw) {
        Ok(Value::Object(mut obj)) => {
            if !obj.contains_key("type") {
                obj.insert("type".to_string(), Value::String("answer".to_string()));
            }
            serde_json::to_vec(&obj)
                .map_err(|err| format!("normalize session description failed: {err}"))?
        }
        Ok(_) => raw,
        Err(err) => {
            let payload_text = String::from_utf8(raw.clone()).map_err(|utf8_err| {
                format!("decode answer payload json failed: {err}; utf8: {utf8_err}")
            })?;
            serde_json::to_vec(&serde_json::json!({
                "type": "answer",
                "sdp": payload_text,
            }))
            .map_err(|err| format!("normalize legacy answer payload failed: {err}"))?
        }
    };
    let desc: RTCSessionDescription = serde_json::from_slice(&raw)
        .map_err(|err| format!("decode session description failed: {err}"))?;
    peer.set_remote_description(desc)
        .await
        .map_err(|err| format!("set_remote_description failed: {err}"))?;
    Ok(())
}

pub(crate) async fn apply_candidate(peer: &Arc<RTCPeerConnection>, payload: &str) -> Result<(), String> {
    if payload.is_empty() {
        return Ok(());
    }
    let raw = BASE64_STANDARD
        .decode(payload)
        .map_err(|err| format!("decode candidate failed: {err}"))?;
    let raw = match serde_json::from_slice::<Value>(&raw) {
        Ok(Value::Object(_)) => raw,
        Ok(Value::String(text)) => serde_json::to_vec(&serde_json::json!({
            "candidate": text,
        }))
        .map_err(|err| format!("normalize string candidate failed: {err}"))?,
        Ok(_) => raw,
        Err(err) => {
            let text = String::from_utf8(raw).map_err(|utf8_err| {
                format!("decode candidate payload json failed: {err}; utf8: {utf8_err}")
            })?;
            serde_json::to_vec(&serde_json::json!({
                "candidate": text,
            }))
            .map_err(|err| format!("normalize legacy candidate payload failed: {err}"))?
        }
    };
    let candidate: RTCIceCandidateInit = serde_json::from_slice(&raw)
        .map_err(|err| format!("decode candidate JSON failed: {err}"))?;
    peer.add_ice_candidate(candidate)
        .await
        .map_err(|err| format!("add_ice_candidate failed: {err}"))?;
    Ok(())
}

pub(crate) async fn create_session(
    session_id: String,
    room: Arc<Room>,
    outbound: mpsc::UnboundedSender<SignalMessage>,
    input_sender: Sender<InputEvent>,
) -> Result<(), String> {
    let mut config = RTCConfiguration::default();
    config.ice_servers = vec![webrtc::ice_transport::ice_server::RTCIceServer {
        urls: vec!["stun:stun.l.google.com:19302".to_string()],
        ..Default::default()
    }];

    let mut media_engine = MediaEngine::default();
    let video_rtcp_feedback = vec![
        RTCPFeedback {
            typ: TYPE_RTCP_FB_GOOG_REMB.to_owned(),
            parameter: "".to_owned(),
        },
        RTCPFeedback {
            typ: TYPE_RTCP_FB_CCM.to_owned(),
            parameter: "fir".to_owned(),
        },
        RTCPFeedback {
            typ: TYPE_RTCP_FB_NACK.to_owned(),
            parameter: "".to_owned(),
        },
        RTCPFeedback {
            typ: TYPE_RTCP_FB_NACK.to_owned(),
            parameter: "pli".to_owned(),
        },
    ];
    media_engine
        .register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_H264.to_owned(),
                    clock_rate: video_sender::VIDEO_RTP_CLOCK_RATE,
                    channels: 0,
                    sdp_fmtp_line: video_sender::H264_SDP_FMTP_LINE.to_owned(),
                    rtcp_feedback: video_rtcp_feedback.clone(),
                },
                payload_type: 102,
                ..Default::default()
            },
            RTPCodecType::Video,
        )
        .map_err(|err| format!("register H264 codec failed: {err:?}"))?;

    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)
        .map_err(|err| format!("register default interceptors failed: {err:?}"))?;

    let api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();
    let peer = Arc::new(
        api.new_peer_connection(config)
            .await
            .map_err(|err| format!("{err:?}"))?,
    );

    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: video_sender::VIDEO_RTP_CLOCK_RATE,
            channels: 0,
            sdp_fmtp_line: video_sender::H264_SDP_FMTP_LINE.to_owned(),
            rtcp_feedback: video_rtcp_feedback.clone(),
        },
        "game-video".to_owned(),
        "game-video".to_owned(),
    ));
    let rtp_sender = peer
        .add_track(video_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|err| format!("add video track failed: {err:?}"))?;

    let room_for_rtcp = room.clone();
    let sid_for_rtcp = session_id.clone();
    tokio::spawn(async move {
        loop {
            let (packets, _attrs) = match rtp_sender.read_rtcp().await {
                Ok(value) => value,
                Err(_) => break,
            };

            let mut request_keyframe = false;
            for packet in packets {
                let any = packet.as_any();
                if any.is::<PictureLossIndication>()
                    || any.is::<FullIntraRequest>()
                    || any.is::<RapidResynchronizationRequest>()
                {
                    request_keyframe = true;
                    break;
                }
            }

            if request_keyframe {
                room_for_rtcp.request_idr();
                debug!(session_id = %sid_for_rtcp, "rtcp keyframe request received");
            }
        }
    });

    let room_for_state = room.clone();
    let sid = session_id.clone();
    peer.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        let room = room_for_state.clone();
        let sid = sid.clone();
        Box::pin(async move {
            info!(session_id = sid, state = ?state, "peer state changed");
            if matches!(
                state,
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
            ) {
                if let Some(session) = room.unregister_session(&sid) {
                    let peer = Arc::clone(session.peer());
                    tokio::spawn(async move {
                        let _ = peer.close().await;
                    });
                }
            }
        })
    }));

    let outbound_ice = outbound.clone();
    let session_for_ice = session_id.clone();
    peer.on_ice_candidate(Box::new(move |candidate| {
        let outbound_ice = outbound_ice.clone();
        let session_for_ice = session_for_ice.clone();
        Box::pin(async move {
            if let Some(candidate) = candidate {
                let candidate = match candidate.to_json() {
                    Ok(value) => value,
                    Err(err) => {
                        warn!(session_id = session_for_ice, error = %err, "failed to serialize candidate");
                        return;
                    }
                };
                let data = match serde_json::to_string(&candidate) {
                    Ok(json) => BASE64_STANDARD.encode(json),
                    Err(err) => {
                        warn!(session_id = session_for_ice, error = %err, "failed to serialize candidate payload");
                        return;
                    }
                };
                let msg = SignalMessage::with_payload(
                    signal_ids::CANDIDATE,
                    Some(session_for_ice.clone()),
                    Some(data),
                );
                let _ = outbound_ice.send(msg);
            }
        })
    }));

    let unreliable_channel_opts = Some(RTCDataChannelInit {
        ordered: Some(false),
        max_retransmits: Some(0),
        ..Default::default()
    });

    let data_input_channel = peer
        .create_data_channel(rtc_labels::GAME_INPUT, unreliable_channel_opts.clone())
        .await
        .map_err(|err| format!("create data channel failed: {err:?}"))?;
    let audio_channel = peer
        .create_data_channel(rtc_labels::GAME_AUDIO, unreliable_channel_opts)
        .await
        .map_err(|err| format!("create audio channel failed: {err:?}"))?;

    let sid_for_input = session_id.clone();
    let room_for_input = room.clone();
    let input_sender_for_input = input_sender.clone();
    data_input_channel.on_message(Box::new(move |msg: DataChannelMessage| {
        let sid_for_input = sid_for_input.clone();
        let input_sender = input_sender_for_input.clone();
        let room_for_input = room_for_input.clone();
        Box::pin(async move {
            if msg.data.is_empty() {
                return;
            }

            let raw = msg.data.to_vec();
            room_for_input.buffer_or_send_input(&sid_for_input, raw, &input_sender, "datachannel");
        })
    }));

    let offer = peer
        .create_offer(None)
        .await
        .map_err(|err| format!("create_offer failed: {err:?}"))?;
    peer.set_local_description(offer.clone())
        .await
        .map_err(|err| format!("set_local_description failed: {err:?}"))?;

    let video_queue = Arc::new(VideoSampleQueue::new(VIDEO_SESSION_QUEUE_CAPACITY));

    let session = Arc::new(Session::new(
        session_id.clone(),
        Arc::clone(&peer),
        data_input_channel,
        video_track.clone(),
        video_queue.clone(),
        audio_channel,
    ));

    let session_id_for_task = session_id.clone();
    let room_for_video_sender = room.clone();
    let peer_for_video_sender = Arc::clone(&peer);
    tokio::spawn(async move {
        let mut sent_keyframe = false;
        while let Some(sample) = video_queue.pop().await {
            if !sent_keyframe && !sample.is_keyframe() {
                continue;
            }
            if sample.is_keyframe() {
                sent_keyframe = true;
            }

            if let Err(err) = video_track.write_sample(sample.sample()).await {
                warn!(
                    session_id = %session_id_for_task,
                    bytes = sample.sample().data.len(),
                    error = ?err,
                    "video send failed; closing peer"
                );
                break;
            }
        }
        video_queue.close();
        room_for_video_sender.unregister_session(&session_id_for_task);
        let _ = peer_for_video_sender.close().await;
        debug!(session_id = session_id_for_task, "video sender task ended");
    });

    if !room.register_session(session_id.clone(), Arc::clone(&session)) {
        peer.close().await.map_err(|err| format!("{err:?}"))?;
        return Err("session already exists".to_string());
    }

    room.request_encoder_refresh();
    if let Some(slot) = room.player_index_for_session(session.id()) {
        session.set_player(Some(slot));
    }

    let local_desc =
        serde_json::to_vec(&offer).map_err(|err| format!("serialize offer failed: {err}"))?;
    let msg = SignalMessage::with_payload(
        signal_ids::OFFER,
        Some(session_id),
        Some(BASE64_STANDARD.encode(local_desc)),
    );
    outbound
        .send(msg)
        .map_err(|_| "failed to send offer".to_string())?;

    Ok(())
}
