import {
  SIGNALING_MESSAGE_IDS,
  buildSignalingMessage,
  parseSignalMessage,
} from "../../store/protocol";
import { logError, logWarn } from "../../utils/log";
import { ignorePromiseRejection } from "../../utils/ignore";

import { createAudioPlaybackController } from "./audioPlayback";
import { RTC_DATA_CHANNEL_LABELS } from "./generatedRtcLabels";
import { startInputLoop } from "./inputLoop";
import { startVideoStallDetector } from "./videoStallDetector";

const READY_ICE_STATES = new Set(["connected", "completed"]);
const RTC_DATA_CHANNEL_BACKPRESSURE_LIMIT = 96 * 1024;
const GAMEPAD_AXIS_THRESHOLD = 0.5;

const disableVideoReceiverPlayoutDelay = (track, receiver) => {
  if (track?.kind !== "video" || !receiver || !("playoutDelayHint" in receiver)) {
    return;
  }

  try {
    receiver.playoutDelayHint = 0;
  } catch (error) {
    logWarn("[webrtc] failed to apply playout delay hint", error);
  }
};

const getConnectedGamepads = () => {
  if (typeof navigator === "undefined") {
    return [];
  }
  const raw = navigator.getGamepads
    ? navigator.getGamepads()
    : navigator.webkitGetGamepads
      ? navigator.webkitGetGamepads()
      : [];
  return raw && typeof raw.length === "number" ? raw : [];
};

const getPrimaryGamepad = () => {
  const pads = getConnectedGamepads();
  for (const pad of pads) {
    if (pad) {
      return pad;
    }
  }
  return null;
};

const isGamepadButtonPressed = (value) => {
  if (typeof value === "number") {
    return value === 1;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (value.pressed) {
    return true;
  }
  if (typeof value.value === "number" && value.value > 0.75) {
    return true;
  }
  return false;
};

const isGamepadBindingPressed = (binding, pad) => {
  if (!binding || !pad) {
    return false;
  }

  if (binding.type === "button") {
    const buttonIndex = Number.parseInt(binding.button, 10);
    if (!Number.isFinite(buttonIndex) || buttonIndex < 0) {
      return false;
    }
    return isGamepadButtonPressed(pad.buttons?.[buttonIndex]);
  }

  if (binding.type === "axis") {
    const axisIndex = Number.parseInt(binding.axis, 10);
    if (!Number.isFinite(axisIndex) || axisIndex < 0) {
      return false;
    }
    const rawValue = Number(pad.axes?.[axisIndex]);
    if (!Number.isFinite(rawValue)) {
      return false;
    }
    const dir = binding.dir === -1 ? -1 : 1;
    const threshold = Number(binding.threshold);
    const safeThreshold =
      Number.isFinite(threshold) && threshold > 0 && threshold < 1
        ? threshold
        : GAMEPAD_AXIS_THRESHOLD;
    return dir === -1 ? rawValue <= -safeThreshold : rawValue >= safeThreshold;
  }

  return false;
};

const attachDocumentListener = (type, handler) => {
  document.addEventListener(type, handler);
  return () => document.removeEventListener(type, handler);
};

const attachWindowListener = (type, handler) => {
  window.addEventListener(type, handler);
  return () => window.removeEventListener(type, handler);
};

const attachSocketListener = (conn, type, handler) => {
  if (!conn) {
    return () => {};
  }

  conn.addEventListener(type, handler);
  return () => conn.removeEventListener(type, handler);
};

export const createGameSessionRuntime = ({
  conn,
  workerID,
  remoteVideoRef,
  joypadKeys,
  keyboardCodesRef,
  keyboardMappingRef,
  gamepadMappingRef,
  touchStateRef,
  externalInputMaskRef,
  setConnectionState,
  setHasMedia,
  setVideoStalled,
  setAudioStatus,
}) => {
  let cleanup = () => {};
  let isStarted = false;
  let resumeAudioHandler = null;

  const runtime = {
    start() {
      if (isStarted) {
        return;
      }

      isStarted = true;
      cleanup = startRuntime();
    },
    dispose() {
      if (!isStarted) {
        return;
      }

      isStarted = false;
      const cleanupNow = cleanup;
      cleanup = () => {};
      cleanupNow();
      resumeAudioHandler = null;
    },
    resumeAudio(context = {}) {
      resumeAudioHandler?.(context);
    },
  };

  const startRuntime = () => {
    let isDisposed = false;
    const pc = new RTCPeerConnection({
      iceServers: [
        {
          urls: "stun:stun.l.google.com:19302",
        },
      ],
    });

    const remoteVideoElement = remoteVideoRef.current;
    setHasMedia(false);
    setVideoStalled(false);
    setAudioStatus("unknown");
    setConnectionState(pc.connectionState || "new");

    let inputChannel;
    let audioChannel;
    const mediaStream = new MediaStream();
    const audioResumeRef = { current: null };
    const audioController = createAudioPlaybackController({
      setAudioStatus,
      resumeAudioRef: audioResumeRef,
    });
    const {
      requestAudioPlayback,
      resumeAudioFromGesture,
      resumeAudioFromForeground,
      handleAudioMessage,
    } = audioController;
    resumeAudioHandler = ({ fromUserGesture = false } = {}) => {
      audioResumeRef.current?.({ fromUserGesture });
    };

    const syncMediaDisplay = () => {
      const remoteVideo = remoteVideoRef.current;
      if (!remoteVideo) {
        return;
      }

      if (mediaStream.getTracks().length > 0) {
        remoteVideo.autoplay = true;
        remoteVideo.playsInline = true;
        remoteVideo.muted = true;
        remoteVideo.defaultMuted = true;
        remoteVideo.setAttribute("playsinline", "");
        remoteVideo.setAttribute("webkit-playsinline", "");
        remoteVideo.srcObject = mediaStream;
        remoteVideo.style.display = "block";
        const playPromise = remoteVideo.play();
        ignorePromiseRejection(playPromise, "[webrtc] remote video play failed");
      } else {
        remoteVideo.srcObject = null;
        remoteVideo.style.display = "none";
      }
    };

    const isPeerConnected = () =>
      pc.connectionState !== "closed" &&
      pc.connectionState !== "failed" &&
      READY_ICE_STATES.has(pc.iceConnectionState);

    pc.onconnectionstatechange = () => {
      setConnectionState(pc.connectionState || "unknown");
    };

    pc.ontrack = (event) => {
      disableVideoReceiverPlayoutDelay(event.track, event.receiver);
      mediaStream.addTrack(event.track);
      setHasMedia(true);
      setVideoStalled(false);
      syncMediaDisplay();
    };

    pc.ondatachannel = (event) => {
      if (event.channel.label === RTC_DATA_CHANNEL_LABELS.GAME_AUDIO) {
        audioChannel = event.channel;
        audioChannel.binaryType = "arraybuffer";
        audioChannel.onopen = () => {
          requestAudioPlayback(false);
        };
        audioChannel.onmessage = (msgEvent) => {
          handleAudioMessage(msgEvent.data);
        };
        return;
      }

      if (event.channel.label !== RTC_DATA_CHANNEL_LABELS.GAME_INPUT) {
        logWarn("[webrtc] ignoring unknown data channel", event.channel.label);
        return;
      }

      inputChannel = event.channel;
      inputChannel.onopen = () => {
        syncMediaDisplay();
      };
      inputChannel.onerror = (error) => {
        logWarn("[input] data channel error", error);
      };
      inputChannel.onclose = () => {};
    };

    const sendSignal = (message) => {
      if (!conn || conn.readyState !== WebSocket.OPEN) {
        return false;
      }

      conn.send(JSON.stringify(message));
      return true;
    };

    const canSendInput = () =>
      inputChannel?.readyState === "open" &&
      inputChannel.bufferedAmount < RTC_DATA_CHANNEL_BACKPRESSURE_LIMIT &&
      isPeerConnected();

    const sendInputViaSignal = (packetValue) => {
      if (!conn || conn.readyState !== WebSocket.OPEN) {
        return false;
      }

      if (packetValue === undefined) {
        return false;
      }

      const encoded = btoa(
        String.fromCharCode(packetValue & 0xff, (packetValue >>> 8) & 0xff)
      );
      sendSignal(
        buildSignalingMessage({
          id: SIGNALING_MESSAGE_IDS.INPUT,
          data: encoded,
          targetID: workerID,
        })
      );

      return true;
    };

    const sendInputViaDataChannel = (inputPacket, packetValue) => {
      if (!canSendInput()) {
        return false;
      }

      if (packetValue === undefined) {
        return false;
      }

      try {
        inputChannel.send(inputPacket);
        return true;
      } catch (err) {
        logWarn("[input] data channel send failed", err);
        return sendInputViaSignal(packetValue);
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      try {
        sendSignal(
          buildSignalingMessage({
            id: SIGNALING_MESSAGE_IDS.CANDIDATE,
            data: btoa(JSON.stringify(event.candidate)),
            targetID: workerID,
          })
        );
      } catch (err) {
        logWarn("[webrtc] failed to serialize ice candidate", err);
      }
    };

    const initMessage = buildSignalingMessage({
      id: SIGNALING_MESSAGE_IDS.INIT_WEBRTC,
      targetID: workerID,
    });
    const handleSocketOpen = () => {
      sendSignal(initMessage);
    };

    const pendingIceCandidates = [];
    let messageProcessingChain = Promise.resolve();

    const flushPendingIceCandidates = async () => {
      if (isDisposed || pc.signalingState === "closed" || !pc.remoteDescription) {
        return;
      }

      while (pendingIceCandidates.length > 0) {
        const candidate = pendingIceCandidates.shift();
        if (!candidate) {
          continue;
        }
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          logWarn("[webrtc] failed to add ice candidate", err);
        }
      }
    };

    const handleSocketMessageInner = async (event) => {
      if (isDisposed) {
        return;
      }

      const msg = parseSignalMessage(event.data);
      if (!msg) {
        return;
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.OFFER) {
        try {
          await pc.setRemoteDescription(
            new RTCSessionDescription(JSON.parse(atob(msg.data)))
          );
          const answer = await pc.createAnswer();
          answer.sdp = answer.sdp.replace(
            /(a=fmtp:111 .*)/g,
            "$1;stereo=1;sprop-stereo=1"
          );
          await pc.setLocalDescription(answer);
          sendSignal(
            buildSignalingMessage({
              id: SIGNALING_MESSAGE_IDS.ANSWER,
              data: btoa(JSON.stringify(answer)),
              targetID: workerID,
            })
          );
          await flushPendingIceCandidates();
        } catch (err) {
          logError("[webrtc] failed to process offer/answer", err);
        }
        return;
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.CANDIDATE) {
        try {
          const decoded = atob(msg.data);
          const candidate = new RTCIceCandidate(JSON.parse(decoded));
          if (!pc.remoteDescription) {
            pendingIceCandidates.push(candidate);
            return;
          }
          await pc.addIceCandidate(candidate);
        } catch (err) {
          logError("[webrtc] failed to process candidate", err);
        }
      }
    };

    const handleSocketMessage = (event) => {
      messageProcessingChain = messageProcessingChain
        .then(() => handleSocketMessageInner(event))
        .catch((err) => {
          logError("[webrtc] failed to process signaling message", err);
        });
    };

    const handleSocketError = (event) => {
      logError("[signal] websocket error", event);
    };

    const handleSocketClose = (event) => {
      logWarn("[signal] websocket closed", {
        code: event.code,
        reason: event.reason,
      });
    };

    if (conn?.readyState === WebSocket.OPEN) {
      handleSocketOpen();
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        setVideoStalled(true);
      }
    };

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "closed") {
        setConnectionState("closed");
      }
    };

    const stopVideoStallDetector = startVideoStallDetector({
      remoteVideoRef,
      isPeerConnected,
      setVideoStalled,
    });

    const stopInputLoop = startInputLoop({
      joypadKeys,
      keyboardCodesRef,
      keyboardMappingRef,
      gamepadMappingRef,
      touchStateRef,
      externalInputMaskRef,
      getPrimaryGamepad,
      isGamepadBindingPressed,
      sendInputViaDataChannel,
      sendInputViaSignal,
      requestAudioPlayback,
    });

    const recoverAudioOnForeground = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      resumeAudioFromForeground();
    };

    const removeListeners = [
      attachSocketListener(conn, "open", handleSocketOpen),
      attachSocketListener(conn, "message", handleSocketMessage),
      attachSocketListener(conn, "error", handleSocketError),
      attachSocketListener(conn, "close", handleSocketClose),
      attachDocumentListener("keydown", resumeAudioFromGesture),
      attachDocumentListener("mousedown", resumeAudioFromGesture),
      attachDocumentListener("pointerdown", resumeAudioFromGesture),
      attachDocumentListener("touchstart", resumeAudioFromGesture),
      attachDocumentListener("visibilitychange", recoverAudioOnForeground),
      attachWindowListener("pageshow", recoverAudioOnForeground),
      attachWindowListener("focus", recoverAudioOnForeground),
      attachWindowListener("online", recoverAudioOnForeground),
    ];

    return () => {
      isDisposed = true;
      stopInputLoop();
      stopVideoStallDetector();
      if (conn?.readyState === WebSocket.OPEN) {
        sendSignal(
          buildSignalingMessage({
            id: SIGNALING_MESSAGE_IDS.TERMINATE_SESSION,
            targetID: workerID,
          })
        );
      }

      for (const removeListener of removeListeners) {
        removeListener();
      }

      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onsignalingstatechange = null;
      pc.ondatachannel = null;
      if (inputChannel && inputChannel.readyState === "open") {
        inputChannel.close();
      }
      if (audioChannel && audioChannel.readyState === "open") {
        audioChannel.close();
      }
      pc.close();
      mediaStream.getTracks().forEach((track) => track.stop());
      if (remoteVideoElement) {
        remoteVideoElement.srcObject = null;
        remoteVideoElement.style.display = "block";
      }
      audioController.cleanup();
    };
  };

  return runtime;
};
