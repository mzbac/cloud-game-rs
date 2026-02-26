import { useCallback, useEffect, useRef, useState } from "react";
import {
  SIGNALING_MESSAGE_IDS,
  parseSignalMessage,
} from "../store/protocol";
import { controllerHostMessage } from "../store/signalingMessages";
import { logWarn } from "../utils/log";

const nextControllerUrl = (code, workerID) => {
  const safeWorkerID = typeof workerID === "string" ? workerID.trim() : "";
  if (typeof window === "undefined" || !window.location) {
    return safeWorkerID
      ? `/controller/${code}?worker=${encodeURIComponent(safeWorkerID)}`
      : `/controller/${code}`;
  }

  const url = new URL(`/controller/${encodeURIComponent(code)}`, window.location.origin);
  if (safeWorkerID) {
    url.searchParams.set("worker", safeWorkerID);
  }
  return url.toString();
};

export const usePhoneControllerHost = ({ conn, workerID, onEnableAudio }) => {
  const [pairingCode, setPairingCode] = useState("");
  const [controllerUrl, setControllerUrl] = useState("");
  const [connectedControllers, setConnectedControllers] = useState(0);

  const pairingCodeRef = useRef("");
  const connectedControllerIdsRef = useRef(new Set());
  const refreshTimerRef = useRef(null);

  const publishControllerCount = useCallback(() => {
    setConnectedControllers(connectedControllerIdsRef.current.size);
  }, []);

  const sendSignal = useCallback(
    (message) => {
      if (!conn || conn.readyState !== WebSocket.OPEN) {
        return false;
      }
      try {
        conn.send(JSON.stringify(message));
        return true;
      } catch (err) {
        logWarn("[controller-host] signal send failed", err);
        return false;
      }
    },
    [conn]
  );

  const sendHostRegistration = useCallback(() => {
    if (!workerID) {
      return false;
    }
    return sendSignal(controllerHostMessage(workerID));
  }, [sendSignal, workerID]);

  const addController = useCallback(
    (controllerId) => {
      if (!controllerId) {
        return;
      }
      connectedControllerIdsRef.current.add(controllerId);
      publishControllerCount();
    },
    [publishControllerCount]
  );

  const removeController = useCallback(
    (controllerId) => {
      if (!controllerId) {
        return;
      }
      connectedControllerIdsRef.current.delete(controllerId);
      publishControllerCount();
    },
    [publishControllerCount]
  );

  useEffect(() => {
    if (!conn || !workerID) {
      return undefined;
    }

    const connectedControllerIds = connectedControllerIdsRef.current;

    const handleSocketOpen = () => {
      connectedControllerIds.clear();
      publishControllerCount();

      pairingCodeRef.current = "";
      setPairingCode("");
      setControllerUrl("");

      sendHostRegistration();
    };

    const handleSocketMessage = (event) => {
      const msg = parseSignalMessage(event.data);
      if (!msg) {
        return;
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.CONTROLLER_READY) {
        try {
          const payload = JSON.parse(msg.data || "{}");
          const code = typeof payload.code === "string" ? payload.code : "";
          if (!code || code === pairingCodeRef.current) {
            return;
          }
          pairingCodeRef.current = code;
          setPairingCode(code);
          setControllerUrl(nextControllerUrl(code, workerID));
        } catch {}
        return;
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.CONTROLLER_AUDIO) {
        if (typeof onEnableAudio === "function") {
          onEnableAudio();
        }
        return;
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.CONTROLLER_JOINED) {
        addController(msg.sessionID);
        return;
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.CONTROLLER_LEFT) {
        removeController(msg.sessionID);
      }
    };

    if (conn.readyState === WebSocket.OPEN) {
      handleSocketOpen();
    } else {
      conn.addEventListener("open", handleSocketOpen);
    }
    conn.addEventListener("message", handleSocketMessage);

    refreshTimerRef.current = window.setInterval(() => {
      sendHostRegistration();
    }, 60000);

    return () => {
      conn.removeEventListener("open", handleSocketOpen);
      conn.removeEventListener("message", handleSocketMessage);

      if (refreshTimerRef.current) {
        window.clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }

      connectedControllerIds.clear();
      publishControllerCount();
    };
  }, [
    addController,
    conn,
    onEnableAudio,
    publishControllerCount,
    removeController,
    sendHostRegistration,
    workerID,
  ]);

  const refreshPairing = useCallback(() => {
    pairingCodeRef.current = "";
    setPairingCode("");
    setControllerUrl("");
    sendHostRegistration();
  }, [sendHostRegistration]);

  return {
    pairingCode,
    controllerUrl,
    connectedControllers,
    refreshPairing,
  };
};
