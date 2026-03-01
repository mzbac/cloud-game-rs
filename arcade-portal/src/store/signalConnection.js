import { SIGNALING_MESSAGE_IDS, parseSignalMessage } from "./protocol";

const MAX_RECONNECT_DELAY_MS = 5000;
const CONNECT_TIMEOUT_MS = 8000;

export const createSignalConnection = ({
  url,
  urlForLog,
  heartbeatMs,
  onSocketChange,
  onGames,
  onPlayerCount,
  logInfo,
  logWarn,
  logError,
}) => {
  let closedByApp = false;
  let reconnectTimer;
  let socket;
  let cleanupSocket;
  let cleanupLifecycle;

  const isPageVisible = () => {
    if (typeof document === "undefined") {
      return true;
    }
    return document.visibilityState === "visible";
  };

  const isOnline = () => {
    if (typeof navigator === "undefined") {
      return true;
    }
    return navigator.onLine !== false;
  };

  const canAttemptConnection = () => !closedByApp && isPageVisible() && isOnline();

  const sendGetGames = (targetSocket) => {
    if (!targetSocket || targetSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      targetSocket.send(
        JSON.stringify({
          id: SIGNALING_MESSAGE_IDS.GET_GAMES,
        })
      );
    } catch (err) {
      if (typeof logError === "function") {
        logError("[signal] getGames send failed", err);
      }
      try {
        targetSocket.close();
      } catch {
        // ignore
      }
    }
  };

  const safeClearTimeout = (timeoutId) => {
    if (!timeoutId) {
      return;
    }
    clearTimeout(timeoutId);
  };

  const connect = (attempt = 0) => {
    const nextSocket = new WebSocket(url);
    let heartbeatId;
    let connectTimeoutId;

    if (typeof onSocketChange === "function") {
      onSocketChange(nextSocket);
    }

    if (typeof logInfo === "function") {
      logInfo(`[signal] connecting to ${urlForLog} (attempt ${attempt + 1})`);
    }

    const stopConnectTimeout = () => {
      if (connectTimeoutId) {
        safeClearTimeout(connectTimeoutId);
        connectTimeoutId = null;
      }
    };

    const startHeartbeat = () => {
      heartbeatId = window.setInterval(() => {
        requestGames();
      }, heartbeatMs);
    };

    const stopHeartbeat = () => {
      if (heartbeatId) {
        window.clearInterval(heartbeatId);
        heartbeatId = null;
      }
    };

    const handleClose = (evt) => {
      stopConnectTimeout();
      stopHeartbeat();
      if (closedByApp) {
        return;
      }

      if (socket !== nextSocket) {
        return;
      }

      if (!canAttemptConnection()) {
        if (typeof logWarn === "function") {
          logWarn("[signal] websocket closed while offline/backgrounded; waiting for foreground", {
            code: evt.code,
            reason: evt.reason,
          });
        }
        return;
      }

      const delay = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
      if (typeof logWarn === "function") {
        logWarn("[signal] websocket closed, reconnecting", {
          code: evt.code,
          reason: evt.reason,
          codeName: evt.code || "unknown",
          delayMs: delay,
        });
      }

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!canAttemptConnection()) {
          return;
        }
        socket = connect(Math.min(attempt + 1, 5));
      }, delay);
    };

    const handleMessage = (event) => {
      const msg = parseSignalMessage(event.data);
      if (!msg) {
        return;
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.GAMES) {
        try {
          if (typeof onGames === "function") {
            onGames(JSON.parse(msg.data || "{}"));
          }
        } catch {
          if (typeof logWarn === "function") {
            logWarn("[signal] malformed games payload:", msg.data);
          }
        }
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.UPDATE_PLAYER_COUNT) {
        if (typeof onPlayerCount === "function") {
          onPlayerCount({
            roomId: msg.sessionID,
            count: msg.data,
          });
        }
      }
    };

    const requestGames = () => {
      sendGetGames(nextSocket);
    };

    const handleOpen = () => {
      stopConnectTimeout();
      requestGames();
      startHeartbeat();
    };

    const handleError = (evt) => {
      if (typeof logError === "function") {
        logError("[signal] websocket error", {
          readyState: nextSocket.readyState,
          event: evt,
        });
      }
    };

    nextSocket.addEventListener("open", handleOpen);
    nextSocket.addEventListener("close", handleClose);
    nextSocket.addEventListener("message", handleMessage);
    nextSocket.addEventListener("error", handleError);

    cleanupSocket = () => {
      nextSocket.removeEventListener("open", handleOpen);
      nextSocket.removeEventListener("close", handleClose);
      nextSocket.removeEventListener("message", handleMessage);
      nextSocket.removeEventListener("error", handleError);
      stopConnectTimeout();
      stopHeartbeat();
    };

    connectTimeoutId = window.setTimeout(() => {
      if (socket !== nextSocket) {
        return;
      }
      if (nextSocket.readyState === WebSocket.CONNECTING) {
        if (typeof logWarn === "function") {
          logWarn("[signal] websocket connect timeout, reconnecting", {
            timeoutMs: CONNECT_TIMEOUT_MS,
          });
        }
        try {
          nextSocket.close();
        } catch {
          // ignore
        }
      }
    }, CONNECT_TIMEOUT_MS);

    return nextSocket;
  };

  if (canAttemptConnection()) {
    socket = connect();
  } else {
    socket = null;
  }

  const recoverOnForeground = () => {
    if (closedByApp) {
      return;
    }

    if (!canAttemptConnection()) {
      return;
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
      sendGetGames(socket);
      return;
    }

    if (socket && socket.readyState === WebSocket.CONNECTING) {
      return;
    }

    if (socket && socket.readyState === WebSocket.CLOSING) {
      return;
    }

    if (reconnectTimer) {
      return;
    }

    socket = connect();
  };

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        recoverOnForeground();
      }
    };

    window.addEventListener("pageshow", recoverOnForeground);
    window.addEventListener("focus", recoverOnForeground);
    window.addEventListener("online", recoverOnForeground);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    cleanupLifecycle = () => {
      window.removeEventListener("pageshow", recoverOnForeground);
      window.removeEventListener("focus", recoverOnForeground);
      window.removeEventListener("online", recoverOnForeground);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }

  return {
    close: () => {
      closedByApp = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      if (cleanupLifecycle) {
        cleanupLifecycle();
        cleanupLifecycle = null;
      }

      if (cleanupSocket) {
        cleanupSocket();
        cleanupSocket = null;
      }

      if (
        socket &&
        socket.readyState !== WebSocket.CLOSED &&
        socket.readyState !== WebSocket.CLOSING
      ) {
        socket.close();
      }

      socket = null;
      if (typeof onSocketChange === "function") {
        onSocketChange(null);
      }
    },
  };
};
