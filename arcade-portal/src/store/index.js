import React, { createContext, useReducer, useEffect } from "react";
import {
  redactSignalingUrlForLog,
  resolveSignalingUrl,
} from "./protocol";
import { createSignalConnection } from "./signalConnection";
import { logError, logInfo, logWarn } from "../utils/log";
import { parsePlayerCount } from "../utils/playerCount";

const SIGNAL_HEARTBEAT_MS = 15000;

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

// Provider component
export const AppDataProvider = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const normalizedUrl = resolveSignalingUrl();
    const normalizedUrlForLog = redactSignalingUrlForLog(normalizedUrl);
    const connection = createSignalConnection({
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

    return () => {
      connection.close();
    };
  }, []);

  return (
    <AppDataContext.Provider value={{ state }}>
      {children}
    </AppDataContext.Provider>
  );
};
