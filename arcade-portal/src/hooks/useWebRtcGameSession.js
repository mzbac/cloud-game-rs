import { useCallback, useEffect, useRef, useState } from "react";

import { createGameSessionRuntime } from "./webrtc/gameSessionRuntime";

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
  const runtimeRef = useRef(null);

  const resumeAudio = useCallback((event) => {
    const fromUserGesture = Boolean(event);
    runtimeRef.current?.resumeAudio({ fromUserGesture });
  }, []);

  useEffect(() => {
    const runtime = createGameSessionRuntime({
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
    });
    runtimeRef.current = runtime;
    runtime.start();
    return () => {
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
      runtime.dispose();
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
