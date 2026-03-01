import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AppDataContext } from "./store";
import {
  SIGNALING_MESSAGE_IDS,
  parseSignalMessage,
} from "./store/protocol";
import { controllerAudioMessage, controllerInputMessage, controllerJoinMessage } from "./store/signalingMessages";
import TouchControls from "./components/touchControls";
import "./controller.css";
import { ignoreError } from "./utils/ignore";
import {
  safeLocalStorageGetItem,
  safeLocalStorageSetItem,
  writeJsonToLocalStorage,
} from "./utils/storage";

const ACTION_BITS = {
  A: 1 << 0,
  B: 1 << 1,
  X: 1 << 2,
  Y: 1 << 3,
  Z: 1 << 4,
  C: 1 << 5,
  SELECT: 1 << 6,
  START: 1 << 7,
  UP: 1 << 8,
  DOWN: 1 << 9,
  LEFT: 1 << 10,
  RIGHT: 1 << 11,
};

const ACTION_OPTIONS = [
  { bit: ACTION_BITS.UP, label: "UP" },
  { bit: ACTION_BITS.DOWN, label: "DOWN" },
  { bit: ACTION_BITS.LEFT, label: "LEFT" },
  { bit: ACTION_BITS.RIGHT, label: "RIGHT" },
  { bit: ACTION_BITS.A, label: "A" },
  { bit: ACTION_BITS.B, label: "B" },
  { bit: ACTION_BITS.X, label: "X" },
  { bit: ACTION_BITS.Y, label: "Y" },
  { bit: ACTION_BITS.Z, label: "Z" },
  { bit: ACTION_BITS.C, label: "C" },
  { bit: ACTION_BITS.START, label: "START" },
  { bit: ACTION_BITS.SELECT, label: "SELECT" },
];

const ACTION_LABEL_BY_BIT = ACTION_OPTIONS.reduce((map, item) => {
  map[item.bit] = item.label;
  return map;
}, {});

const SLOT_KEYS = ["up", "down", "left", "right", "a", "b", "c", "x", "y", "z", "start", "select"];

const SLOT_CONFIG = [
  { slot: "up", label: "Stick Up" },
  { slot: "down", label: "Stick Down" },
  { slot: "left", label: "Stick Left" },
  { slot: "right", label: "Stick Right" },
  { slot: "x", label: "Top Left Face" },
  { slot: "y", label: "Top Middle Face" },
  { slot: "z", label: "Top Right Face" },
  { slot: "a", label: "Bottom Left Face" },
  { slot: "b", label: "Bottom Middle Face" },
  { slot: "c", label: "Bottom Right Face" },
  { slot: "select", label: "Select Button" },
  { slot: "start", label: "Start Button" },
];

const DEFAULT_TOUCH_MAPPING = {
  up: ACTION_BITS.UP,
  down: ACTION_BITS.DOWN,
  left: ACTION_BITS.LEFT,
  right: ACTION_BITS.RIGHT,
  a: ACTION_BITS.A,
  b: ACTION_BITS.B,
  c: ACTION_BITS.C,
  x: ACTION_BITS.X,
  y: ACTION_BITS.Y,
  z: ACTION_BITS.Z,
  start: ACTION_BITS.START,
  select: ACTION_BITS.SELECT,
};

const TOUCH_MAPPING_STORAGE_KEY = "cloudArcade.phoneController.touchMapping.v1";
const LAST_JOIN_CODE_STORAGE_KEY = "cloudArcade.phoneController.lastJoinCode.v1";

const SEND_TICK_MS = 1000 / 60;

const STATUS_TEXT = {
  idle: "Enter pairing code.",
  pairing: "Pairing with TV...",
  paired: "Paired. This phone is now an active player.",
  error: "Pairing failed. Check code and retry.",
  disconnected: "TV disconnected. Trying to reconnect...",
};

const encodeMaskBase64 = (mask) =>
  btoa(String.fromCharCode(mask & 0xff, (mask >>> 8) & 0xff));

const safeJoinCode = (value) =>
  typeof value === "string" ? value.trim().toUpperCase().slice(0, 12) : "";

const loadLastJoinCodeFromStorage = () => {
  const raw = safeLocalStorageGetItem(LAST_JOIN_CODE_STORAGE_KEY);
  return safeJoinCode(raw);
};

const saveLastJoinCodeToStorage = (value) => {
  const normalized = safeJoinCode(value);
  if (!normalized) {
    return;
  }
  safeLocalStorageSetItem(LAST_JOIN_CODE_STORAGE_KEY, normalized);
};

const isPortraitOrientation = () => {
  if (typeof window === "undefined") {
    return false;
  }
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(orientation: portrait)").matches;
  }
  return window.innerHeight > window.innerWidth;
};

const normalizeTouchMapping = (candidate) => {
  const allowedBits = new Set(ACTION_OPTIONS.map((item) => item.bit));
  const next = {};
  const usedBits = new Set();

  const source = candidate && typeof candidate === "object" ? candidate : {};

  for (const slot of SLOT_KEYS) {
    const rawValue = source[slot];
    if (typeof rawValue === "number" && allowedBits.has(rawValue) && !usedBits.has(rawValue)) {
      next[slot] = rawValue;
      usedBits.add(rawValue);
    }
  }

  const fallbackBits = SLOT_KEYS.map((slot) => DEFAULT_TOUCH_MAPPING[slot]).concat(
    ACTION_OPTIONS.map((item) => item.bit)
  );

  for (const slot of SLOT_KEYS) {
    if (typeof next[slot] === "number") {
      continue;
    }

    const fallback = fallbackBits.find((bit) => !usedBits.has(bit));
    if (typeof fallback === "number") {
      next[slot] = fallback;
      usedBits.add(fallback);
    } else {
      next[slot] = DEFAULT_TOUCH_MAPPING[slot];
    }
  }

  return next;
};

const loadTouchMappingFromStorage = () => {
  if (typeof window === "undefined" || !window.localStorage) {
    return normalizeTouchMapping(DEFAULT_TOUCH_MAPPING);
  }

  try {
    const raw = window.localStorage.getItem(TOUCH_MAPPING_STORAGE_KEY);
    if (!raw) {
      return normalizeTouchMapping(DEFAULT_TOUCH_MAPPING);
    }
    return normalizeTouchMapping(JSON.parse(raw));
  } catch {
    return normalizeTouchMapping(DEFAULT_TOUCH_MAPPING);
  }
};

function ControllerPage() {
  const { code } = useParams();
  const routeCode = useMemo(() => safeJoinCode(code), [code]);
  const storedCode = useMemo(() => loadLastJoinCodeFromStorage(), []);
  const initialCode = routeCode || storedCode;
  const [joinCode, setJoinCode] = useState(initialCode);
  const [statusMode, setStatusMode] = useState(initialCode ? "pairing" : "idle");
  const [statusText, setStatusText] = useState(
    initialCode ? STATUS_TEXT.pairing : STATUS_TEXT.idle
  );
  const [isPortrait, setIsPortrait] = useState(() => isPortraitOrientation());
  const [hudCollapsed, setHudCollapsed] = useState(false);
  const [showRemapPanel, setShowRemapPanel] = useState(false);
  const [touchMapping, setTouchMapping] = useState(() => loadTouchMappingFromStorage());

  const { state } = useContext(AppDataContext);
  const { conn } = state;

  const hostIdRef = useRef("");
  const maskRef = useRef(0);
  const lastSentMaskRef = useRef(-1);
  const statusModeRef = useRef(initialCode ? "pairing" : "idle");
  const joinCodeRef = useRef(joinCode);
  const autoCollapseRef = useRef(false);

  const setStatus = useCallback((mode, text = STATUS_TEXT[mode]) => {
    statusModeRef.current = mode;
    setStatusMode(mode);
    setStatusText(text || STATUS_TEXT.idle);
  }, []);

  const statusSummary = useMemo(() => {
    switch (statusMode) {
      case "paired":
        return "Connected";
      case "pairing":
        return "Pairing...";
      case "disconnected":
        return "Reconnecting...";
      case "error":
        return "Pairing failed";
      case "idle":
      default:
        return "Enter code";
    }
  }, [statusMode]);

  useEffect(() => {
    if (statusMode !== "paired") {
      autoCollapseRef.current = false;
      setHudCollapsed(false);
      return;
    }

    if (autoCollapseRef.current) {
      return;
    }

    autoCollapseRef.current = true;
    setHudCollapsed(true);
  }, [statusMode]);

  const sendSignal = useCallback(
    (message) => {
      if (!conn || conn.readyState !== WebSocket.OPEN) {
        return false;
      }
      try {
        conn.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    },
    [conn]
  );

  const sendJoin = useCallback(() => {
    const normalizedCode = safeJoinCode(joinCode);
    if (!normalizedCode) {
      setStatus("idle");
      return false;
    }

    const sent = sendSignal(
      controllerJoinMessage(normalizedCode)
    );

    if (sent) {
      saveLastJoinCodeToStorage(normalizedCode);
      setStatus("pairing");
    }

    return sent;
  }, [joinCode, sendSignal, setStatus]);

  useEffect(() => {
    joinCodeRef.current = joinCode;
  }, [joinCode]);

  useEffect(() => {
    if (!conn) {
      return undefined;
    }

    const handleOpen = () => {
      lastSentMaskRef.current = -1;
      setStatus("pairing", "Reconnecting controller...");
      sendJoin();
    };

    const handleClose = () => {
      hostIdRef.current = "";
      lastSentMaskRef.current = -1;
      if (statusModeRef.current !== "idle") {
        setStatus("disconnected");
      }
    };

    const handleMessage = async (event) => {
      const msg = parseSignalMessage(event.data);
      if (!msg) {
        return;
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.CONTROLLER_REJECTED) {
        setStatus("error");
        hostIdRef.current = "";
        return;
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.CONTROLLER_LEFT) {
        setStatus("disconnected");
        hostIdRef.current = "";
        return;
      }

      if (msg.id === SIGNALING_MESSAGE_IDS.CONTROLLER_JOINED) {
        if (!msg.sessionID) {
          return;
        }
        hostIdRef.current = msg.sessionID;
        lastSentMaskRef.current = -1;
        saveLastJoinCodeToStorage(joinCodeRef.current);
        setStatus("paired");
      }
    };

    if (conn.readyState === WebSocket.OPEN) {
      handleOpen();
    } else {
      conn.addEventListener("open", handleOpen);
    }
    conn.addEventListener("close", handleClose);
    conn.addEventListener("message", handleMessage);

    return () => {
      conn.removeEventListener("open", handleOpen);
      conn.removeEventListener("close", handleClose);
      conn.removeEventListener("message", handleMessage);
      hostIdRef.current = "";
    };
  }, [conn, sendJoin, setStatus]);

  useEffect(() => {
    const retry = window.setInterval(() => {
      if (!conn || conn.readyState !== WebSocket.OPEN) {
        return;
      }
      if (statusModeRef.current !== "pairing" && statusModeRef.current !== "disconnected") {
        return;
      }
      sendJoin();
    }, 3000);

    return () => {
      window.clearInterval(retry);
    };
  }, [conn, sendJoin]);

  useEffect(() => {
    const recoverOnForeground = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      lastSentMaskRef.current = -1;

      if (conn && conn.readyState === WebSocket.OPEN) {
        if (statusModeRef.current !== "idle") {
          setStatus("pairing", "Reconnecting controller...");
        }
        sendJoin();
        return;
      }

      if (statusModeRef.current !== "idle") {
        setStatus("disconnected");
      }
    };

    document.addEventListener("visibilitychange", recoverOnForeground);
    window.addEventListener("pageshow", recoverOnForeground);

    return () => {
      document.removeEventListener("visibilitychange", recoverOnForeground);
      window.removeEventListener("pageshow", recoverOnForeground);
    };
  }, [conn, sendJoin, setStatus]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const currentMask = maskRef.current & 0xffff;
      if (!hostIdRef.current) {
        return;
      }
      if (currentMask === lastSentMaskRef.current) {
        return;
      }

      const sent = sendSignal(
        controllerInputMessage(hostIdRef.current, encodeMaskBase64(currentMask))
      );

      if (sent) {
        lastSentMaskRef.current = currentMask;
        setStatus("paired");
      }
    }, SEND_TICK_MS);

    return () => window.clearInterval(timer);
  }, [sendSignal, setStatus]);

  const setMaskBit = useCallback((bit, pressed) => {
    const nextMask = pressed ? maskRef.current | bit : maskRef.current & ~bit;
    maskRef.current = nextMask & 0xffff;
  }, []);

  useEffect(() => {
    writeJsonToLocalStorage(TOUCH_MAPPING_STORAGE_KEY, touchMapping);
  }, [touchMapping]);

  const updateMappingSlot = useCallback((slot, nextBit) => {
    setTouchMapping((previous) => {
      if (!Number.isFinite(nextBit) || previous[slot] === nextBit) {
        return previous;
      }

      const next = { ...previous };
      const swappedSlot = SLOT_KEYS.find((key) => key !== slot && next[key] === nextBit);
      if (swappedSlot) {
        next[swappedSlot] = previous[slot];
      }
      next[slot] = nextBit;
      return normalizeTouchMapping(next);
    });
  }, []);

  const resetMapping = useCallback(() => {
    setTouchMapping(normalizeTouchMapping(DEFAULT_TOUCH_MAPPING));
  }, []);

  const closeRemapPanel = useCallback(() => {
    setShowRemapPanel(false);
  }, []);

  const openRemapPanel = useCallback(() => {
    setShowRemapPanel(true);
    setHudCollapsed(false);
  }, []);

  const requestHostAudio = useCallback(() => {
    if (!hostIdRef.current) {
      return;
    }
    sendSignal(controllerAudioMessage(hostIdRef.current));
  }, [sendSignal]);

  const touchLabels = useMemo(
    () => ({
      x: ACTION_LABEL_BY_BIT[touchMapping.x] || "X",
      y: ACTION_LABEL_BY_BIT[touchMapping.y] || "Y",
      z: ACTION_LABEL_BY_BIT[touchMapping.z] || "Z",
      a: ACTION_LABEL_BY_BIT[touchMapping.a] || "A",
      b: ACTION_LABEL_BY_BIT[touchMapping.b] || "B",
      c: ACTION_LABEL_BY_BIT[touchMapping.c] || "C",
      start: ACTION_LABEL_BY_BIT[touchMapping.start] || "Start",
      select: ACTION_LABEL_BY_BIT[touchMapping.select] || "Select",
    }),
    [touchMapping]
  );

  const requestLandscape = useCallback(async () => {
    if (typeof document !== "undefined" && !document.fullscreenElement) {
      const root = document.documentElement;
      if (root && typeof root.requestFullscreen === "function") {
        try {
          await root.requestFullscreen();
        } catch (err) {
          ignoreError("[controller] requestFullscreen failed", err);
        }
      }
    }

    if (typeof window !== "undefined" && window.screen?.orientation?.lock) {
      try {
        await window.screen.orientation.lock("landscape");
      } catch (err) {
        ignoreError("[controller] orientation.lock failed", err);
      }
    }
  }, []);

  useEffect(() => {
    const updateOrientation = () => {
      setIsPortrait(isPortraitOrientation());
    };

    updateOrientation();
    window.addEventListener("resize", updateOrientation);
    window.addEventListener("orientationchange", updateOrientation);

    const mediaQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(orientation: portrait)")
        : null;

    if (mediaQuery) {
      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", updateOrientation);
      } else if (typeof mediaQuery.addListener === "function") {
        mediaQuery.addListener(updateOrientation);
      }
    }

    return () => {
      window.removeEventListener("resize", updateOrientation);
      window.removeEventListener("orientationchange", updateOrientation);
      if (mediaQuery) {
        if (typeof mediaQuery.removeEventListener === "function") {
          mediaQuery.removeEventListener("change", updateOrientation);
        } else if (typeof mediaQuery.removeListener === "function") {
          mediaQuery.removeListener(updateOrientation);
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!showRemapPanel) {
      return undefined;
    }

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        closeRemapPanel();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeRemapPanel, showRemapPanel]);

  return (
    <div
      className={`ControllerPage${isPortrait ? " ControllerPage--portrait" : ""}${
        showRemapPanel ? " ControllerPage--modalOpen" : ""
      }`}
    >
      <div className="ControllerPage__overlay" />
      {isPortrait ? (
        <div className="ControllerRotateGate">
          <div className="ControllerRotateGate__title">Rotate To Landscape</div>
          <div className="ControllerRotateGate__body">
            Phone controller is tuned for horizontal play.
          </div>
          <button type="button" className="ControllerRotateGate__button" onClick={requestLandscape}>
            Enable Landscape
          </button>
        </div>
      ) : null}

      {showRemapPanel ? (
        <>
          <div className="ControllerModalBackdrop" role="presentation" onClick={closeRemapPanel} />
          <section className="ControllerModal" role="dialog" aria-modal="true" aria-label="Button mapping">
            <div className="ControllerModal__header">
              <div className="ControllerModal__title">Button Mapping</div>
              <button type="button" className="ControllerModal__close" onClick={closeRemapPanel}>
                Close
              </button>
            </div>
            <div className="ControllerRemapPanel__grid">
              {SLOT_CONFIG.map((entry) => (
                <label key={entry.slot} className="ControllerRemapRow">
                  <span className="ControllerRemapRow__label">{entry.label}</span>
                  <select
                    className="ControllerRemapRow__select"
                    value={touchMapping[entry.slot]}
                    onChange={(event) => updateMappingSlot(entry.slot, Number(event.target.value))}
                  >
                    {ACTION_OPTIONS.map((option) => (
                      <option key={option.bit} value={option.bit}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="ControllerModal__actions">
              <button type="button" className="ControllerSecondaryButton" onClick={resetMapping}>
                Reset Mapping
              </button>
            </div>
          </section>
        </>
      ) : null}

      <div className="ControllerShell">
        <header className="ControllerHeader">
          <div className="ControllerHeader__title">Phone Controller</div>
          <div className="ControllerHeader__subtitle">Uses the same touch layout as the in-game controls.</div>
        </header>

        <section className={`ControllerPairCard${hudCollapsed ? " ControllerPairCard--collapsed" : ""}`}>
          <div className="ControllerStatusRow">
            <div className={`ControllerStatus ControllerStatus--${statusMode}`}>
              {hudCollapsed ? statusSummary : statusText}
            </div>
            {statusMode === "paired" ? (
              <button
                type="button"
                className="ControllerHudToggle"
                aria-label={hudCollapsed ? "Show controller details" : "Hide controller details"}
                onClick={() => setHudCollapsed((value) => !value)}
              >
                {hudCollapsed ? "Details" : "Hide"}
              </button>
            ) : null}
          </div>

          {!hudCollapsed ? (
            <div className="ControllerPairCard__row">
              <input
                className="ControllerCodeInput"
                value={joinCode}
                onChange={(event) => setJoinCode(safeJoinCode(event.target.value))}
                placeholder="Pairing code"
                maxLength={12}
                inputMode="numeric"
                pattern="[0-9]*"
                autoCorrect="off"
                autoCapitalize="characters"
                readOnly={Boolean(routeCode)}
              />
              <button type="button" className="ControllerPairButton" onClick={sendJoin}>
                {hostIdRef.current ? "Reconnect" : "Pair"}
              </button>
            </div>
          ) : null}

          <div className="ControllerPairCard__actions">
            <button type="button" className="ControllerSecondaryButton" onClick={openRemapPanel}>
              Remap Buttons
            </button>
            {statusMode === "paired" ? (
              <button type="button" className="ControllerSecondaryButton" onClick={requestHostAudio}>
                Enable game audio
              </button>
            ) : null}
            {!hudCollapsed ? (
              <button type="button" className="ControllerSecondaryButton" onClick={resetMapping}>
                Reset Mapping
              </button>
            ) : null}
          </div>
        </section>
      </div>

      <TouchControls
        enabled={!isPortrait && !showRemapPanel}
        mapping={touchMapping}
        labels={touchLabels}
        onButtonChange={setMaskBit}
      />
    </div>
  );
}

export default ControllerPage;
