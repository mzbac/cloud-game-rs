import { useCallback, useEffect, useRef, useState } from "react";

import { startWebRtcGameSession } from "./webrtc/gameSessionEngine";

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

  const resumeAudio = useCallback((event) => {
    const fromUserGesture = Boolean(event);
    resumeAudioRef.current?.({ fromUserGesture });
  }, []);

  useEffect(() => {
    return startWebRtcGameSession({
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
      resumeAudioRef,
    });
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
