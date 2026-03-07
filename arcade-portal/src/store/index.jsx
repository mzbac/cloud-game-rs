import React, { createContext, useReducer, useEffect } from "react";
import {
  redactSignalingUrlForLog,
  resolveSignalingUrl,
  resolveSnapshotUrl,
} from "./protocol";
import { createSignalConnection } from "./signalConnection";
import { logError, logInfo, logWarn } from "../utils/log";
import { parsePlayerCount } from "../utils/playerCount";
import { useLocation } from "react-router-dom";

const SIGNAL_HEARTBEAT_MS = 15000;
const SNAPSHOT_POLL_MS = 15000;

// Initial state for app data
const initialState = {
  currentPlayersInRoom: 0,
  playerCountsByRoom: {},
};

// Define a reducer to handle updates to app data
const reducer = (state, action) => {
  switch (action.type) {
    case "UPDATE_APP_DATA":
      return { ...state, ...action.payload };
    case "UPDATE_SOCKET":
      return { ...state, conn: action.payload };
    case "GAMES":
      return { ...state, games: action.payload };
    case "SNAPSHOT":
      return {
        ...state,
        games: action.payload.games,
        playerCountsByRoom: action.payload.playerCountsByRoom,
      };
    case "UPDATE_PLAYER_COUNT":
      if (action.payload && typeof action.payload === "object") {
        const roomId = action.payload.roomId;
        if (!roomId) {
          return {
            ...state,
            currentPlayersInRoom: parsePlayerCount(action.payload.count),
          };
        }

        const parsed = parsePlayerCount(action.payload.count);
        return {
          ...state,
          currentPlayersInRoom: parsed,
          playerCountsByRoom: {
            ...state.playerCountsByRoom,
            [roomId]: parsed,
          },
        };
      }
      return {
        ...state,
        currentPlayersInRoom: parsePlayerCount(action.payload),
      };
    default:
      return state;
  }
};

// Create a context for app data
export const AppDataContext = createContext({ state: initialState });

const shouldUseRealtimeConnection = (pathname) =>
  typeof pathname === "string" &&
  (pathname.startsWith("/game/") ||
    pathname === "/controller" ||
    pathname.startsWith("/controller/"));

// Provider component
export const AppDataProvider = ({ children }) => {
  const { pathname } = useLocation();
  const [state, dispatch] = useReducer(reducer, initialState);
  const enableRealtime = shouldUseRealtimeConnection(pathname);

  useEffect(() => {
    const normalizedUrl = resolveSignalingUrl();
    const normalizedUrlForLog = redactSignalingUrlForLog(normalizedUrl);
    const snapshotUrl = resolveSnapshotUrl();
    let cancelled = false;
    let snapshotPollId = null;

    const applySnapshot = (payload) => {
      const games =
        payload?.games && typeof payload.games === "object" ? payload.games : {};
      const playerCountsByRoom =
        payload?.playerCountsByRoom && typeof payload.playerCountsByRoom === "object"
          ? payload.playerCountsByRoom
          : {};

      dispatch({
        type: "SNAPSHOT",
        payload: {
          games,
          playerCountsByRoom,
        },
      });
    };

    const fetchSnapshot = async () => {
      try {
        const response = await fetch(snapshotUrl, {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        if (!cancelled) {
          applySnapshot(payload);
        }
      } catch {
        // ignore snapshot failures and fall back to the websocket path when enabled
      }
    };

    fetchSnapshot();

    let connection = null;
    if (enableRealtime) {
      connection = createSignalConnection({
        url: normalizedUrl,
        urlForLog: normalizedUrlForLog,
        heartbeatMs: SIGNAL_HEARTBEAT_MS,
        onSocketChange: (conn) => {
          dispatch({ type: "UPDATE_SOCKET", payload: conn });
        },
        onGames: (games) => {
          dispatch({
            type: "GAMES",
            payload: games,
          });
        },
        onPlayerCount: ({ roomId, count }) => {
          dispatch({
            type: "UPDATE_PLAYER_COUNT",
            payload: {
              roomId,
              count,
            },
          });
        },
        logInfo,
        logWarn,
        logError,
      });
    } else {
      dispatch({ type: "UPDATE_SOCKET", payload: null });
      snapshotPollId = window.setInterval(fetchSnapshot, SNAPSHOT_POLL_MS);
    }

    return () => {
      cancelled = true;
      if (snapshotPollId) {
        window.clearInterval(snapshotPollId);
      }
      connection?.close();
    };
  }, [enableRealtime, pathname]);

  return (
    <AppDataContext.Provider value={{ state }}>
      {children}
    </AppDataContext.Provider>
  );
};
