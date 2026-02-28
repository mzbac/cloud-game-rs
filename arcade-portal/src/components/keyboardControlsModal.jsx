import React, { useEffect, useMemo, useState } from "react";
import { Button, Modal, Space, Tag, Typography } from "antd";
import "./keyboardControlsModal.css";

const { Text } = Typography;

const codeToLabel = (code) => {
  if (!code || typeof code !== "string") {
    return "";
  }
  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3);
  }
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5);
  }
  if (code === "Space") {
    return "Space";
  }
  if (code === "Escape") {
    return "Esc";
  }
  const arrowLabels = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  if (arrowLabels[code]) {
    return arrowLabels[code];
  }
  return code;
};

function KeyboardControlsModal({
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

  const listeningText = useMemo(() => {
    if (!listening) {
      return null;
    }
    const action = actions?.find((entry) => entry.id === listening.actionId);
    const label = action?.label || "control";
    return `Press a key for ${label} (${listening.slot === 0 ? "primary" : "alternate"}). Esc cancels.`;
  }, [actions, listening]);

  useEffect(() => {
    if (!open) {
      setListening(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !listening) {
      return;
    }

    const handleKeyDown = (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === "Escape") {
        setListening(null);
        return;
      }

      if (!event.code) {
        return;
      }

      onBind(listening.actionId, event.code, listening.slot);
      setListening(null);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [listening, onBind, open]);

  return (
    <Modal
      open={open}
      title="Keyboard controls"
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
      <div className="keyboardControlsModal__hint">
        <Text type="secondary">
          Click a bind button, then press a key. Keys are based on physical layout (e.g. “KeyW”).
        </Text>
        {listeningText ? (
          <div style={{ marginTop: 8 }}>
            <Tag color="blue">{listeningText}</Tag>
          </div>
        ) : null}
      </div>

      <div className="keyboardControlsModal__list">
        {actions?.map((action) => {
          const codes = Array.isArray(mapping?.[action.id]) ? mapping[action.id] : [];
          const primary = codes?.[0] || null;
          const alt = codes?.[1] || null;

          return (
            <div key={action.id} className="keyboardControlsModal__row">
              <div className="keyboardControlsModal__label">{action.label}</div>
              <div className="keyboardControlsModal__bindings">
                {primary ? <Tag>{codeToLabel(primary)}</Tag> : <span className="keyboardControlsModal__empty">Unbound</span>}
                {alt ? <Tag>{codeToLabel(alt)}</Tag> : null}
              </div>
              <div className="keyboardControlsModal__buttons">
                <Button
                  size="small"
                  type={
                    listening?.actionId === action.id && listening?.slot === 0 ? "primary" : "default"
                  }
                  onClick={() => setListening({ actionId: action.id, slot: 0 })}
                >
                  Bind
                </Button>
                <Button
                  size="small"
                  type={
                    listening?.actionId === action.id && listening?.slot === 1 ? "primary" : "default"
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

export default KeyboardControlsModal;
