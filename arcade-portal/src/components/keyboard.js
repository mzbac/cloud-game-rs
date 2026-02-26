import React from "react";
import { Button, Tag, Typography } from "antd";
import "./keyboard.css";

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
  const arrowLabels = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  if (arrowLabels[code]) {
    return arrowLabels[code];
  }
  if (code === "Space") {
    return "Space";
  }
  return code;
};

function Keyboard({ mapping, actions, onCustomize }) {
  return (
    <div className="keyboardHintCard" aria-label="Keyboard controls">
      <div className="keyboardHintCard__header">
        <div>
          <div className="keyboardHintCard__title">Keyboard</div>
          <Text type="secondary">Customize keys to match your setup.</Text>
        </div>
        <Button size="small" onClick={onCustomize}>
          Customize
        </Button>
      </div>

      <div className="keyboardHintCard__grid">
        {actions?.map((action) => {
          const codes = Array.isArray(mapping?.[action.id]) ? mapping[action.id] : [];
          return (
            <div key={action.id} className="keyboardHintCard__row">
              <div className="keyboardHintCard__label">{action.label}</div>
              <div className="keyboardHintCard__tags">
                {codes.length ? (
                  codes.map((code) => <Tag key={code}>{codeToLabel(code)}</Tag>)
                ) : (
                  <span className="keyboardHintCard__empty">Unbound</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default Keyboard;
