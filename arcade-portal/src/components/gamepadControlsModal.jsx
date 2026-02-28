import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Modal, Space, Tag, Typography } from "antd";
import "./gamepadControlsModal.css";

const { Text } = Typography;

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

const isButtonPressed = (value) => {
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

const snapshotPad = (pad) => {
  const buttons = Array.isArray(pad?.buttons)
    ? pad.buttons.map((button) => isButtonPressed(button))
    : [];
  const axes = Array.isArray(pad?.axes) ? pad.axes.slice() : [];
  return { buttons, axes };
};

const bindingToLabel = (binding) => {
  if (!binding || typeof binding !== "object") {
    return "";
  }

  if (binding.type === "button") {
    const idx = Number.parseInt(binding.button, 10);
    return Number.isFinite(idx) ? `Button ${idx}` : "";
  }

  if (binding.type === "axis") {
    const idx = Number.parseInt(binding.axis, 10);
    const dir = binding.dir === -1 ? "−" : "+";
    return Number.isFinite(idx) ? `Axis ${idx} ${dir}` : "";
  }

  return "";
};

function GamepadControlsModal({
  open,
  onClose,
  mapping,
  actions,
  onBind,
  onClear,
  onReset,
  getContainer,
}) {
  const [listening, setListening] = useState(null);
  const [gamepadId, setGamepadId] = useState("");
  const rafRef = useRef(null);

  const listeningText = useMemo(() => {
    if (!listening) {
      return null;
    }
    const action = actions?.find((entry) => entry.id === listening.actionId);
    const label = action?.label || "control";
    return `Press a controller button or move a stick for ${label} (${listening.slot === 0 ? "primary" : "alternate"}). Esc cancels.`;
  }, [actions, listening]);

  useEffect(() => {
    if (!open) {
      setListening(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let raf;
    const tick = () => {
      const pad = getPrimaryGamepad();
      setGamepadId(pad ? pad.id || `Gamepad ${pad.index}` : "");
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);

    return () => {
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open || !listening) {
      return;
    }

    let baseline = null;
    const threshold = 0.6;

    const handleKeyDown = (event) => {
      if (event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setListening(null);
      }
    };

    const step = () => {
      const pad = getPrimaryGamepad();
      if (pad) {
        const snap = snapshotPad(pad);
        if (baseline) {
          const buttons = snap.buttons;
          const prevButtons = baseline.buttons;
          for (let i = 0; i < buttons.length; i++) {
            if (buttons[i] && !prevButtons[i]) {
              onBind(listening.actionId, { type: "button", button: i }, listening.slot);
              setListening(null);
              return;
            }
          }

          const axes = snap.axes;
          const prevAxes = baseline.axes;
          for (let i = 0; i < axes.length; i++) {
            const value = Number(axes[i]);
            const prevValue = Number(prevAxes[i] ?? 0);
            if (
              Number.isFinite(value) &&
              Math.abs(value) >= threshold &&
              Math.abs(prevValue) < threshold
            ) {
              onBind(
                listening.actionId,
                {
                  type: "axis",
                  axis: i,
                  dir: value < 0 ? -1 : 1,
                  threshold,
                },
                listening.slot
              );
              setListening(null);
              return;
            }
          }
        }
        baseline = snap;
      }

      rafRef.current = window.requestAnimationFrame(step);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    rafRef.current = window.requestAnimationFrame(step);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [listening, onBind, open]);

  return (
    <Modal
      open={open}
      title="Controller controls"
      onCancel={onClose}
      getContainer={getContainer}
      footer={
        <Space>
          <Button onClick={onReset}>Reset defaults</Button>
          <Button type="primary" onClick={onClose}>
            Done
          </Button>
        </Space>
      }
    >
      <div className="gamepadControlsModal__hint">
        <Text type="secondary">
          {gamepadId
            ? `Connected: ${gamepadId}. Click Bind, then press a button or move a stick.`
            : "Connect a controller, then click Bind and press a button or move a stick."}
        </Text>
        {listeningText ? (
          <div style={{ marginTop: 8 }}>
            <Tag color="blue">{listeningText}</Tag>
          </div>
        ) : null}
      </div>

      <div className="gamepadControlsModal__list">
        {actions?.map((action) => {
          const bindings = Array.isArray(mapping?.[action.id]) ? mapping[action.id] : [];
          const primary = bindings?.[0] || null;
          const alt = bindings?.[1] || null;

          return (
            <div key={action.id} className="gamepadControlsModal__row">
              <div className="gamepadControlsModal__label">{action.label}</div>
              <div className="gamepadControlsModal__bindings">
                {primary ? (
                  <Tag>{bindingToLabel(primary)}</Tag>
                ) : (
                  <span className="gamepadControlsModal__empty">Unbound</span>
                )}
                {alt ? <Tag>{bindingToLabel(alt)}</Tag> : null}
              </div>
              <div className="gamepadControlsModal__buttons">
                <Button
                  size="small"
                  type={
                    listening?.actionId === action.id && listening?.slot === 0
                      ? "primary"
                      : "default"
                  }
                  onClick={() => setListening({ actionId: action.id, slot: 0 })}
                >
                  Bind
                </Button>
                <Button
                  size="small"
                  type={
                    listening?.actionId === action.id && listening?.slot === 1
                      ? "primary"
                      : "default"
                  }
                  onClick={() => setListening({ actionId: action.id, slot: 1 })}
                >
                  Alt
                </Button>
                <Button
                  size="small"
                  danger
                  disabled={!primary && !alt}
                  onClick={() => onClear(action.id)}
                >
                  Clear
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export default GamepadControlsModal;
