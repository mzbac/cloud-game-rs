import { SIGNALING_MESSAGE_IDS, parseSignalMessage } from "./protocol";

const MAX_RECONNECT_DELAY_MS = 5000;

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

  const connect = (attempt = 0) => {
    const nextSocket = new WebSocket(url);
    let heartbeatId;

    if (typeof onSocketChange === "function") {
      onSocketChange(nextSocket);
    }

    if (typeof logInfo === "function") {
      logInfo(`[signal] connecting to ${urlForLog} (attempt ${attempt + 1})`);
    }

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
      stopHeartbeat();
      if (closedByApp) {
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

      reconnectTimer = setTimeout(() => {
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
      if (nextSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      try {
        nextSocket.send(
          JSON.stringify({
            id: SIGNALING_MESSAGE_IDS.GET_GAMES,
          })
        );
      } catch (err) {
        if (typeof logError === "function") {
          logError("[signal] getGames send failed", err);
        }
      }
    };

    const handleOpen = () => {
      requestGames();
      startHeartbeat();
    };

    const handleError = (evt) => {
      if (typeof logError === "function") {
        logError("[signal] websocket error", evt);
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
      stopHeartbeat();
    };

    return nextSocket;
  };

  socket = connect();

  return {
    close: () => {
      closedByApp = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
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
