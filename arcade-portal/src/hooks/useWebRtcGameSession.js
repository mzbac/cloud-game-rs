import { useCallback, useEffect, useRef, useState } from "react";
import {
  SIGNALING_MESSAGE_IDS,
  buildSignalingMessage,
  parseSignalMessage,
} from "../store/protocol";
import { logError, logWarn } from "../utils/log";
import { createAudioPlaybackController } from "./webrtc/audioPlayback";
import { startInputLoop } from "./webrtc/inputLoop";
import { startVideoStallDetector } from "./webrtc/videoStallDetector";

const READY_ICE_STATES = new Set(["connected", "completed"]);
const RTC_DATA_CHANNEL_BACKPRESSURE_LIMIT = 96 * 1024;
const GAMEPAD_AXIS_THRESHOLD = 0.5;

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

export const useWebRtcGameSession = ({
  conn,
  workerID,
  remoteVideoRef,
  reconnectToken,
  joypadKeys,
  keyboardCodesRef,
  keyboardMappingRef,
  gamepadMappingRef,
  touchStateRef,
  externalInputMaskRef,
}) => {
  const [connectionState, setConnectionState] = useState("new");
  const [hasMedia, setHasMedia] = useState(false);
  const [videoStalled, setVideoStalled] = useState(false);
  const [audioStatus, setAudioStatus] = useState("unknown");
  const resumeAudioRef = useRef(null);

  const resumeAudio = useCallback(() => {
    if (resumeAudioRef.current) {
      resumeAudioRef.current();
    }
  }, []);

  useEffect(() => {
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
    const audioController = createAudioPlaybackController({
      setAudioStatus,
      resumeAudioRef,
    });
    const { requestAudioPlayback, resumeAudioFromGesture, handleAudioMessage } =
      audioController;

    const syncMediaDisplay = () => {
      const remoteVideo = remoteVideoRef.current;
      if (!remoteVideo) {
        return;
      }

      if (mediaStream.getTracks().length > 0) {
        remoteVideo.srcObject = mediaStream;
        remoteVideo.autoplay = true;
        remoteVideo.playsInline = true;
        remoteVideo.muted = true;
        remoteVideo.style.display = "block";
        const playPromise = remoteVideo.play();
        if (playPromise && typeof playPromise.then === "function") {
          playPromise.catch(() => {});
        }
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
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
      }
      setConnectionState(pc.connectionState || "unknown");
    };

    pc.ontrack = (event) => {
      mediaStream.addTrack(event.track);
      setHasMedia(true);
      setVideoStalled(false);
      syncMediaDisplay();
    };

    pc.ondatachannel = (e) => {
      if (e.channel.label === "game-audio") {
        audioChannel = e.channel;
        audioChannel.binaryType = "arraybuffer";
        audioChannel.onopen = () => {
          requestAudioPlayback(false);
        };
        audioChannel.onmessage = (msgEvent) => {
          handleAudioMessage(msgEvent.data);
        };
        return;
      }

      inputChannel = e.channel;
      inputChannel.onopen = () => {
        syncMediaDisplay();
      };
      inputChannel.onerror = (error) => {
        logWarn("[input] data channel error", error);
      };
      inputChannel.onclose = () => {
      };
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
          sessionID: workerID,
        })
      );

      return true;
    };

    const sendInputViaDataChannel = (packet, packetValue) => {
      if (!inputChannel || !canSendInput()) {
        if (packetValue === undefined) {
          return false;
        }

        return sendInputViaSignal(packetValue);
      }

      try {
        inputChannel.send(packet.slice());
        return true;
      } catch (err) {
        logWarn("[input] failed to send input packet", {
          state: inputChannel?.readyState,
          error: `${err}`,
        });

        return sendInputViaSignal(packetValue);
      }
    };

    const init = {
      id: SIGNALING_MESSAGE_IDS.INIT_WEBRTC,
      sessionID: workerID,
    };
    const handleSocketOpen = () => {
      sendSignal(init);
    };

    if (conn?.readyState === WebSocket.OPEN) {
      handleSocketOpen();
    } else if (conn) {
      conn.addEventListener("open", handleSocketOpen);
    }

    const handleSocketMessage = async (event) => {
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
              sessionID: workerID,
            })
          );
        } catch (err) {
          logError("[webrtc] failed to process offer/answer", err);
        }
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.CANDIDATE) {
        try {
          const decoded = atob(msg.data);
          const candidate = new RTCIceCandidate(JSON.parse(decoded));
          pc.addIceCandidate(candidate);
        } catch (err) {
          logError("[webrtc] failed to process candidate", err);
        }
      }
    };

    const handleSocketError = (evt) => {
      logError("[signal] websocket error", evt);
    };
    const handleSocketClose = () => {
      logWarn("[signal] websocket closed");
    };
    if (conn) {
      conn.addEventListener("message", handleSocketMessage);
      conn.addEventListener("error", handleSocketError);
      conn.addEventListener("close", handleSocketClose);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate != null) {
        const candidate = JSON.stringify(event.candidate);
        sendSignal(
          buildSignalingMessage({
            id: SIGNALING_MESSAGE_IDS.CANDIDATE,
            data: btoa(candidate),
            sessionID: workerID,
          })
        );
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

    document.addEventListener("keydown", resumeAudioFromGesture);
    document.addEventListener("mousedown", resumeAudioFromGesture);
    document.addEventListener("pointerdown", resumeAudioFromGesture);
    document.addEventListener("touchstart", resumeAudioFromGesture);

    return () => {
      stopInputLoop();
      stopVideoStallDetector();
      if (conn?.readyState === WebSocket.OPEN) {
        sendSignal(
          buildSignalingMessage({
            id: SIGNALING_MESSAGE_IDS.TERMINATE_SESSION,
            sessionID: workerID,
          })
        );
      }
      if (conn) {
        conn.removeEventListener("open", handleSocketOpen);
        conn.removeEventListener("message", handleSocketMessage);
        conn.removeEventListener("error", handleSocketError);
        conn.removeEventListener("close", handleSocketClose);
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
      document.removeEventListener("keydown", resumeAudioFromGesture);
      document.removeEventListener("mousedown", resumeAudioFromGesture);
      document.removeEventListener("pointerdown", resumeAudioFromGesture);
      document.removeEventListener("touchstart", resumeAudioFromGesture);
    };
  }, [
    conn,
    remoteVideoRef,
    reconnectToken,
    workerID,
    joypadKeys,
    keyboardCodesRef,
    keyboardMappingRef,
    gamepadMappingRef,
    touchStateRef,
    externalInputMaskRef,
  ]);

  return {
    connectionState,
    hasMedia,
    videoStalled,
    audioStatus,
    resumeAudio,
  };
};
