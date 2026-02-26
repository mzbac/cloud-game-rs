import React, { useCallback, useEffect, useContext, useRef, useState } from "react";
import { Button, Space, Tooltip, message } from "antd";
import { AppDataContext } from "./store";
import { useParams } from "react-router-dom";
import Icon from "@ant-design/icons";
import QRCode from "qrcode";
import {
  ArrowLeftOutlined,
  CompressOutlined,
  ExpandOutlined,
  KeyOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  RotateRightOutlined,
  ShareAltOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import Keyboard from "./components/keyboard";
import KeyboardControlsModal from "./components/keyboardControlsModal";
import GamepadControlsModal from "./components/gamepadControlsModal";
import TouchControls from "./components/touchControls";
import { useHistory } from "react-router-dom";
import { useWebRtcGameSession } from "./hooks/useWebRtcGameSession";
import { usePhoneControllerHost } from "./hooks/usePhoneControllerHost";

import "./App.css";
import { shareUrl } from "./utils/share";
import { writeJsonToLocalStorage } from "./utils/storage";
import { parsePlayerCount } from "./utils/playerCount";

const joypad = {
  JOYPAD_A: 0,
  JOYPAD_B: 1,
  JOYPAD_X: 2,
  JOYPAD_Y: 3,
  JOYPAD_L: 4,
  JOYPAD_R: 5,
  JOYPAD_SELECT: 6,
  JOYPAD_START: 7,
  JOYPAD_UP: 8,
  JOYPAD_DOWN: 9,
  JOYPAD_LEFT: 10,
  JOYPAD_RIGHT: 11,
  JOYPAD_R2: 12,
  JOYPAD_L2: 13,
  JOYPAD_R3: 14,
  JOYPAD_L3: 15,
};

const JOYPAD_KEYS = Object.values(joypad);

const DEFAULT_KEY_MAP = {
  [joypad.JOYPAD_LEFT]: ["KeyA", "ArrowLeft"],
  [joypad.JOYPAD_UP]: ["KeyW", "ArrowUp"],
  [joypad.JOYPAD_RIGHT]: ["KeyD", "ArrowRight"],
  [joypad.JOYPAD_DOWN]: ["KeyS", "ArrowDown"],
  [joypad.JOYPAD_A]: ["KeyJ"],
  [joypad.JOYPAD_B]: ["KeyK"],
  [joypad.JOYPAD_X]: ["KeyU"],
  [joypad.JOYPAD_Y]: ["KeyI"],
  [joypad.JOYPAD_L]: ["KeyQ"],
  [joypad.JOYPAD_R]: ["KeyE"],
  [joypad.JOYPAD_SELECT]: ["Digit3"],
  [joypad.JOYPAD_START]: ["Digit1"],
};

const KEYBOARD_ACTIONS = [
  { id: joypad.JOYPAD_UP, label: "Up" },
  { id: joypad.JOYPAD_DOWN, label: "Down" },
  { id: joypad.JOYPAD_LEFT, label: "Left" },
  { id: joypad.JOYPAD_RIGHT, label: "Right" },
  { id: joypad.JOYPAD_A, label: "A" },
  { id: joypad.JOYPAD_B, label: "B" },
  { id: joypad.JOYPAD_X, label: "X" },
  { id: joypad.JOYPAD_Y, label: "Y" },
  { id: joypad.JOYPAD_L, label: "L" },
  { id: joypad.JOYPAD_R, label: "R" },
  { id: joypad.JOYPAD_START, label: "Start" },
  { id: joypad.JOYPAD_SELECT, label: "Select" },
];

const KEYBOARD_MAPPING_STORAGE_KEY = "cloudArcade.keyboardMapping.v1";

const normalizeKeyboardMapping = (candidate) => {
  const normalized = {};
  if (candidate && typeof candidate === "object") {
    for (const [key, value] of Object.entries(candidate)) {
      if (Array.isArray(value)) {
        normalized[key] = value
          .filter((entry) => typeof entry === "string" && entry.length > 0)
          .slice(0, 2);
      } else if (typeof value === "string" && value.length > 0) {
        normalized[key] = [value];
      } else if (value === null) {
        normalized[key] = [];
      }
    }
  }

  const merged = { ...DEFAULT_KEY_MAP, ...normalized };
  for (const key of Object.keys(merged)) {
    const value = merged[key];
    if (Array.isArray(value)) {
      merged[key] = value
        .filter((entry) => typeof entry === "string" && entry.length > 0)
        .slice(0, 2);
    } else if (typeof value === "string" && value.length > 0) {
      merged[key] = [value];
    } else {
      merged[key] = [];
    }
  }
  return merged;
};

const loadKeyboardMappingFromStorage = () => {
  if (typeof window === "undefined" || !window.localStorage) {
    return normalizeKeyboardMapping(DEFAULT_KEY_MAP);
  }

  try {
    const raw = window.localStorage.getItem(KEYBOARD_MAPPING_STORAGE_KEY);
    if (!raw) {
      return normalizeKeyboardMapping(DEFAULT_KEY_MAP);
    }
    return normalizeKeyboardMapping(JSON.parse(raw));
  } catch {
    return normalizeKeyboardMapping(DEFAULT_KEY_MAP);
  }
};

const collectKeyboardCodes = (mapping) => {
  const codes = new Set();
  if (!mapping || typeof mapping !== "object") {
    return codes;
  }
  for (const value of Object.values(mapping)) {
    const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    entries.forEach((code) => {
      if (typeof code === "string" && code.length > 0) {
        codes.add(code);
      }
    });
  }
  return codes;
};

const GameControllerSvg = (props) => (
  <svg {...props} viewBox="0 0 64 64">
    <path
      d="M18 24h28c8.3 0 15 6.7 15 15v6c0 4.4-3.6 8-8 8h-2.8l-6.4-6.4H20.2L13.8 53H11c-4.4 0-8-3.6-8-8v-6c0-8.3 6.7-15 15-15Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
      strokeLinejoin="round"
    />
    <path d="M20 38h12" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    <path d="M26 32v12" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    <circle
      cx="45"
      cy="35"
      r="3"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
    />
    <circle
      cx="52"
      cy="39"
      r="3"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
    />
  </svg>
);

const DEFAULT_GAMEPAD_MAP = {
  [joypad.JOYPAD_LEFT]: [
    { type: "button", button: 14 },
    { type: "axis", axis: 0, dir: -1 },
  ],
  [joypad.JOYPAD_UP]: [
    { type: "button", button: 12 },
    { type: "axis", axis: 1, dir: -1 },
  ],
  [joypad.JOYPAD_RIGHT]: [
    { type: "button", button: 15 },
    { type: "axis", axis: 0, dir: 1 },
  ],
  [joypad.JOYPAD_DOWN]: [
    { type: "button", button: 13 },
    { type: "axis", axis: 1, dir: 1 },
  ],
  [joypad.JOYPAD_A]: [{ type: "button", button: 0 }],
  [joypad.JOYPAD_B]: [{ type: "button", button: 1 }],
  [joypad.JOYPAD_X]: [{ type: "button", button: 2 }],
  [joypad.JOYPAD_Y]: [{ type: "button", button: 3 }],
  [joypad.JOYPAD_L]: [{ type: "button", button: 4 }],
  [joypad.JOYPAD_R]: [{ type: "button", button: 5 }],
  [joypad.JOYPAD_SELECT]: [{ type: "button", button: 8 }],
  [joypad.JOYPAD_START]: [{ type: "button", button: 9 }],
};

const GAMEPAD_MAPPING_STORAGE_KEY = "cloudArcade.gamepadMapping.v1";

const normalizeGamepadBinding = (candidate) => {
  if (!candidate) {
    return null;
  }

  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return { type: "button", button: Math.max(0, Math.floor(candidate)) };
  }

  if (typeof candidate !== "object") {
    return null;
  }

  if (candidate.type === "button") {
    const button = Number.parseInt(candidate.button, 10);
    if (!Number.isFinite(button) || button < 0) {
      return null;
    }
    return { type: "button", button };
  }

  if (candidate.type === "axis") {
    const axis = Number.parseInt(candidate.axis, 10);
    const dir = candidate.dir === -1 ? -1 : 1;
    const threshold = Number(candidate.threshold);
    const safeThreshold =
      Number.isFinite(threshold) && threshold > 0 && threshold < 1
        ? threshold
        : undefined;
    if (!Number.isFinite(axis) || axis < 0) {
      return null;
    }
    return safeThreshold === undefined
      ? { type: "axis", axis, dir }
      : { type: "axis", axis, dir, threshold: safeThreshold };
  }

  return null;
};

const normalizeGamepadMapping = (candidate) => {
  const normalized = {};
  if (candidate && typeof candidate === "object") {
    for (const [key, value] of Object.entries(candidate)) {
      if (Array.isArray(value)) {
        normalized[key] = value
          .map((entry) => normalizeGamepadBinding(entry))
          .filter(Boolean)
          .slice(0, 2);
      } else if (typeof value === "number" || typeof value === "object") {
        const binding = normalizeGamepadBinding(value);
        if (binding) {
          normalized[key] = [binding];
        }
      } else if (value === null) {
        normalized[key] = [];
      }
    }
  }

  const merged = { ...DEFAULT_GAMEPAD_MAP, ...normalized };
  for (const key of Object.keys(merged)) {
    const value = merged[key];
    if (!Array.isArray(value)) {
      merged[key] = [];
      continue;
    }
    merged[key] = value
      .map((entry) => normalizeGamepadBinding(entry))
      .filter(Boolean)
      .slice(0, 2);
  }

  return merged;
};

const loadGamepadMappingFromStorage = () => {
  if (typeof window === "undefined" || !window.localStorage) {
    return normalizeGamepadMapping(DEFAULT_GAMEPAD_MAP);
  }

  try {
    const raw = window.localStorage.getItem(GAMEPAD_MAPPING_STORAGE_KEY);
    if (!raw) {
      return normalizeGamepadMapping(DEFAULT_GAMEPAD_MAP);
    }
    return normalizeGamepadMapping(JSON.parse(raw));
  } catch {
    return normalizeGamepadMapping(DEFAULT_GAMEPAD_MAP);
  }
};

function App() {
  const history = useHistory();
  const isTouchDevice =
    typeof window !== "undefined" &&
    ((window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0));
  const gameRootRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const [showKeyboard, setShowKeyboard] = useState(() => !isTouchDevice);
  const [showControls, setShowControls] = useState(() => isTouchDevice);
  const [showKeyboardSettings, setShowKeyboardSettings] = useState(false);
  const [showGamepadSettings, setShowGamepadSettings] = useState(false);
  const [keyboardMapping, setKeyboardMapping] = useState(() => loadKeyboardMappingFromStorage());
  const [gamepadMapping, setGamepadMapping] = useState(() => loadGamepadMappingFromStorage());
  const keyboardMappingRef = useRef(keyboardMapping);
  const gamepadMappingRef = useRef(gamepadMapping);
  const keyboardCodesRef = useRef(collectKeyboardCodes(keyboardMapping));
  const [reconnectToken, setReconnectToken] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLandscapeLocked, setIsLandscapeLocked] = useState(false);
  const touchStateRef = useRef({});
  const externalInputMaskRef = useRef(0);
  const [controllerQrCodeDataUrl, setControllerQrCodeDataUrl] = useState("");

  const { state } = useContext(AppDataContext);
  const { id: workerID } = useParams();
  const { conn, games, currentPlayersInRoom, playerCountsByRoom } = state;
  const { connectionState, hasMedia, videoStalled, audioStatus, resumeAudio } =
    useWebRtcGameSession({
      conn,
      workerID,
      remoteVideoRef,
      reconnectToken,
      joypadKeys: JOYPAD_KEYS,
      keyboardCodesRef,
      keyboardMappingRef,
      gamepadMappingRef,
      touchStateRef,
      externalInputMaskRef,
    });
  const {
    pairingCode,
    controllerUrl,
    connectedControllers,
  } = usePhoneControllerHost({
    conn,
    workerID,
    onEnableAudio: resumeAudio,
  });
  const safePlayerCountsByRoom =
    playerCountsByRoom && typeof playerCountsByRoom === "object"
      ? playerCountsByRoom
      : {};
  const currentRoomPlayerCount = safePlayerCountsByRoom?.[workerID];
  const hasRoomPlayerCount =
    workerID !== undefined &&
    Object.prototype.hasOwnProperty.call(safePlayerCountsByRoom, workerID);
  const currentPlayerCount = hasRoomPlayerCount
    ? parsePlayerCount(currentRoomPlayerCount)
    : parsePlayerCount(currentPlayersInRoom);
  const playerCountText = Number.isFinite(currentPlayerCount) ? currentPlayerCount : 0;

  const handleTouchButtonChange = useCallback((buttonId, pressed) => {
    if (buttonId === undefined || buttonId === null) {
      return;
    }
    touchStateRef.current[buttonId] = pressed;
  }, []);

  const requestGameFullscreen = useCallback(async () => {
    const root = gameRootRef.current;
    if (root && typeof root.requestFullscreen === "function") {
      try {
        await root.requestFullscreen();
        return true;
      } catch {}
    }

    const video = remoteVideoRef.current;
    if (!video) {
      return false;
    }

    if (typeof video.requestFullscreen === "function") {
      try {
        await video.requestFullscreen();
        return true;
      } catch {}
    }

    if (typeof video.webkitEnterFullscreen === "function") {
      try {
        video.webkitEnterFullscreen();
        return true;
      } catch {}
    }

    return false;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const hasFullscreenElement = Boolean(document.fullscreenElement);
    if (hasFullscreenElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
      return;
    }

    requestGameFullscreen();
  }, [requestGameFullscreen]);

  const handleShare = useCallback(async () => {
    const url = window.location.href;
    const title = games ? games[workerID] : "Cloud Arcade";
    await shareUrl({ title, url });
  }, [games, workerID]);

  useEffect(() => {
    let cancelled = false;
    if (!controllerUrl) {
      setControllerQrCodeDataUrl("");
      return () => {
        cancelled = true;
      };
    }

    QRCode.toDataURL(controllerUrl, {
      margin: 1,
      width: 180,
      errorCorrectionLevel: "M",
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setControllerQrCodeDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setControllerQrCodeDataUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [controllerUrl]);

  const handleReconnect = useCallback(() => {
    setReconnectToken((value) => value + 1);
  }, []);

  useEffect(() => {
    keyboardMappingRef.current = keyboardMapping;
    keyboardCodesRef.current = collectKeyboardCodes(keyboardMapping);
    writeJsonToLocalStorage(KEYBOARD_MAPPING_STORAGE_KEY, keyboardMapping);
  }, [keyboardMapping]);

  useEffect(() => {
    gamepadMappingRef.current = gamepadMapping;
    writeJsonToLocalStorage(GAMEPAD_MAPPING_STORAGE_KEY, gamepadMapping);
  }, [gamepadMapping]);

  const bindKeyboardKey = useCallback((actionId, code, slot) => {
    if (!code || typeof code !== "string") {
      return;
    }

    setKeyboardMapping((prev) => {
      const next = { ...prev };

      for (const key of Object.keys(next)) {
        const value = next[key];
        const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        next[key] = entries.filter((entry) => entry !== code);
      }

      const existingValue = next[actionId];
      const existing = Array.isArray(existingValue)
        ? existingValue.slice()
        : typeof existingValue === "string"
        ? [existingValue]
        : [];

      if (slot === 1) {
        existing[1] = code;
      } else {
        existing[0] = code;
      }

      next[actionId] = existing
        .filter((entry, index, array) => typeof entry === "string" && entry && array.indexOf(entry) === index)
        .slice(0, 2);

      return next;
    });
  }, []);

  const clearKeyboardBinding = useCallback((actionId) => {
    setKeyboardMapping((prev) => ({ ...prev, [actionId]: [] }));
  }, []);

  const resetKeyboardBindings = useCallback(() => {
    setKeyboardMapping(normalizeKeyboardMapping(DEFAULT_KEY_MAP));
  }, []);

  const bindGamepadControl = useCallback((actionId, binding, slot) => {
    if (!binding || typeof binding !== "object") {
      return;
    }

    const bindingType = binding.type;
    if (bindingType !== "button" && bindingType !== "axis") {
      return;
    }

    const bindingsEqual = (a, b) => {
      if (!a || !b || typeof a !== "object" || typeof b !== "object") {
        return false;
      }
      if (a.type !== b.type) {
        return false;
      }
      if (a.type === "button") {
        return Number(a.button) === Number(b.button);
      }
      return Number(a.axis) === Number(b.axis) && (a.dir === -1 ? -1 : 1) === (b.dir === -1 ? -1 : 1);
    };

    setGamepadMapping((prev) => {
      const next = { ...prev };

      for (const key of Object.keys(next)) {
        const value = next[key];
        const entries = Array.isArray(value) ? value : [];
        next[key] = entries.filter((entry) => !bindingsEqual(entry, binding)).slice(0, 2);
      }

      const existingValue = next[actionId];
      const existing = Array.isArray(existingValue) ? existingValue.slice() : [];
      if (slot === 1) {
        existing[1] = binding;
      } else {
        existing[0] = binding;
      }

      next[actionId] = existing
        .filter(Boolean)
        .filter((entry, index, array) => array.findIndex((x) => bindingsEqual(x, entry)) === index)
        .slice(0, 2);

      return next;
    });
  }, []);

  const clearGamepadBinding = useCallback((actionId) => {
    setGamepadMapping((prev) => ({ ...prev, [actionId]: [] }));
  }, []);

  const resetGamepadBindings = useCallback(() => {
    setGamepadMapping(normalizeGamepadMapping(DEFAULT_GAMEPAD_MAP));
  }, []);

  useEffect(() => {
    const handler = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", handler);
    handler();
    return () => {
      document.removeEventListener("fullscreenchange", handler);
    };
  }, []);

  const canLockOrientation =
    typeof window !== "undefined" &&
    window.screen &&
    window.screen.orientation &&
    typeof window.screen.orientation.lock === "function";

  const toggleLandscapeLock = useCallback(async () => {
    if (!canLockOrientation) {
      message.info("Rotate your phone to landscape for horizontal play.");
      return;
    }

    if (isLandscapeLocked) {
      try {
        window.screen.orientation.unlock();
      } catch {}
      setIsLandscapeLocked(false);
      return;
    }

    try {
      await window.screen.orientation.lock("landscape");
      setIsLandscapeLocked(true);
      return;
    } catch {}

    if (!document.fullscreenElement) {
      const root = gameRootRef.current;
      if (root && typeof root.requestFullscreen === "function") {
        try {
          await root.requestFullscreen();
        } catch {}
      }
    }

    try {
      await window.screen.orientation.lock("landscape");
      setIsLandscapeLocked(true);
    } catch {
      message.info("Rotate your phone to landscape for horizontal play.");
    }
  }, [canLockOrientation, isLandscapeLocked]);

  const gameTitle = games ? games[workerID] : "";
  const showReconnectOverlay =
    connectionState === "failed" || connectionState === "disconnected" || videoStalled;
  const reconnectOverlayTitle = videoStalled ? "Stream stalled" : "Connection lost";

  return (
    <div className="GamePage" ref={gameRootRef}>
      <header className="GameHeader">
        <Button
          type="text"
          className="GameHeader__back"
          icon={<ArrowLeftOutlined />}
          onClick={() => history.push("/")}
        />
        <div className="GameHeader__title">
          <div className="GameHeader__name">{gameTitle}</div>
          <div className="GameHeader__meta">
            Players {playerCountText}
          </div>
        </div>
        <Space size={6} className="GameHeader__actions">
          <Tooltip title="Reconnect">
            <Button
              type="text"
              icon={<ReloadOutlined />}
              onClick={handleReconnect}
              aria-label="Reconnect"
            />
          </Tooltip>
          {!isTouchDevice ? (
            <Tooltip title={showKeyboard ? "Hide keyboard help" : "Show keyboard help"}>
              <Button
                type="text"
                icon={<QuestionCircleOutlined />}
                onClick={() => setShowKeyboard((value) => !value)}
                aria-label="Keyboard help"
              />
            </Tooltip>
          ) : null}
          {!isTouchDevice ? (
            <Tooltip title="Keyboard settings">
              <Button
                type="text"
                icon={<KeyOutlined />}
                onClick={() => setShowKeyboardSettings(true)}
                aria-label="Keyboard settings"
              />
            </Tooltip>
          ) : null}
          <Tooltip title="Controller settings">
            <Button
              type="text"
              icon={<Icon component={GameControllerSvg} />}
              onClick={() => setShowGamepadSettings(true)}
              aria-label="Controller settings"
            />
          </Tooltip>
          <Tooltip title={showControls ? "Hide touch controls" : "Show touch controls"}>
            <Button
              type="text"
              icon={<SettingOutlined />}
              onClick={() => setShowControls((value) => !value)}
              aria-label="Touch controls"
            />
          </Tooltip>
          {isTouchDevice ? (
            <Tooltip
              title={
                canLockOrientation
                  ? isLandscapeLocked
                    ? "Unlock landscape"
                    : "Lock landscape"
                  : "Rotate to landscape"
              }
            >
              <Button
                type="text"
                icon={<RotateRightOutlined />}
                onClick={toggleLandscapeLock}
                aria-label="Landscape mode"
              />
            </Tooltip>
          ) : null}
          <Tooltip title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}>
            <Button
              type="text"
              icon={isFullscreen ? <CompressOutlined /> : <ExpandOutlined />}
              onClick={toggleFullscreen}
              aria-label="Fullscreen"
            />
          </Tooltip>
          <Tooltip title="Share">
            <Button
              type="text"
              icon={<ShareAltOutlined />}
              onClick={handleShare}
              aria-label="Share"
            />
          </Tooltip>
        </Space>
      </header>

      <main className="GameStage">
        {!isFullscreen ? (
          <div className="PhonePairingPanel">
            <div className="PhonePairingPanel__header">
              <div className="PhonePairingPanel__title">Phone Controller</div>
              <div className="PhonePairingPanel__meta">
                Active phones: {connectedControllers}
              </div>
            </div>
            <div className="PhonePairingPanel__content">
              <div className="PhonePairingPanel__qrWrap">
                {controllerQrCodeDataUrl ? (
                  <img
                    className="PhonePairingPanel__qr"
                    src={controllerQrCodeDataUrl}
                    alt={`Phone controller QR code ${pairingCode || ""}`.trim()}
                  />
                ) : (
                  <div className="PhonePairingPanel__hint">Generating QR…</div>
                )}
              </div>
              <div className="PhonePairingPanel__details">
                <div className="PhonePairingPanel__code">
                  Code: {pairingCode || "Generating..."}
                </div>
                <div className="PhonePairingPanel__hint">
                  Each paired phone is assigned to the next player slot.
                </div>
                {controllerUrl ? (
                  <a
                    className="PhonePairingPanel__openLink"
                    href={controllerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open controller link
                  </a>
                ) : (
                  <div className="PhonePairingPanel__hint">Waiting for pairing code...</div>
                )}
                <div className="PhonePairingPanel__hint">Scan the QR code with your phone camera.</div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="VideoFrame">
          <video autoPlay id="remoteVideos" className="player" ref={remoteVideoRef}></video>

          {!hasMedia ? <div className="VideoOverlay">Connecting…</div> : null}
          {showReconnectOverlay ? (
            <div className="VideoOverlay VideoOverlay--action">
              <div className="VideoOverlay__title">{reconnectOverlayTitle}</div>
              <Button type="primary" onClick={handleReconnect}>
                Reconnect
              </Button>
            </div>
          ) : null}

          {audioStatus !== "running" ? (
            <button
              type="button"
              className="AudioHint"
              onClick={resumeAudio}
            >
              Tap to enable audio
            </button>
          ) : null}
        </div>

        {showKeyboard ? (
          <div className="KeyboardHint">
            <Keyboard
              mapping={keyboardMapping}
              actions={KEYBOARD_ACTIONS}
              onCustomize={() => setShowKeyboardSettings(true)}
            />
          </div>
        ) : null}
      </main>

      <TouchControls
        enabled={showControls}
        onButtonChange={handleTouchButtonChange}
        mapping={{
          up: joypad.JOYPAD_UP,
          down: joypad.JOYPAD_DOWN,
          left: joypad.JOYPAD_LEFT,
          right: joypad.JOYPAD_RIGHT,
          a: joypad.JOYPAD_A,
          b: joypad.JOYPAD_B,
          c: joypad.JOYPAD_R,
          x: joypad.JOYPAD_X,
          y: joypad.JOYPAD_Y,
          z: joypad.JOYPAD_L,
          start: joypad.JOYPAD_START,
          select: joypad.JOYPAD_SELECT,
        }}
      />

      <KeyboardControlsModal
        open={showKeyboardSettings}
        onClose={() => setShowKeyboardSettings(false)}
        mapping={keyboardMapping}
        actions={KEYBOARD_ACTIONS}
        onBind={bindKeyboardKey}
        onClear={clearKeyboardBinding}
        onReset={resetKeyboardBindings}
        getContainer={() => gameRootRef.current || document.body}
      />

      <GamepadControlsModal
        open={showGamepadSettings}
        onClose={() => setShowGamepadSettings(false)}
        mapping={gamepadMapping}
        actions={KEYBOARD_ACTIONS}
        onBind={bindGamepadControl}
        onClear={clearGamepadBinding}
        onReset={resetGamepadBindings}
        getContainer={() => gameRootRef.current || document.body}
      />
    </div>
  );
}

export default App;
