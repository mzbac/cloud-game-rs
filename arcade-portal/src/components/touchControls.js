import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./touchControls.css";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const getPointerPosition = (event) => {
  if (event && typeof event.clientX === "number" && typeof event.clientY === "number") {
    return { x: event.clientX, y: event.clientY };
  }

  const touch = event?.touches?.[0] || event?.changedTouches?.[0];
  if (touch && typeof touch.clientX === "number" && typeof touch.clientY === "number") {
    return { x: touch.clientX, y: touch.clientY };
  }

  return null;
};

function TouchButton({ label, className, buttonId, onButtonChange }) {
  const pointerIdRef = useRef(null);

  const release = useCallback(() => {
    if (pointerIdRef.current == null) {
      return;
    }
    pointerIdRef.current = null;
    onButtonChange(buttonId, false);
  }, [buttonId, onButtonChange]);

  const handlePointerDown = useCallback(
    (event) => {
      event.preventDefault();
      pointerIdRef.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}

      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(15);
      }

      onButtonChange(buttonId, true);
    },
    [buttonId, onButtonChange]
  );

  const handlePointerUp = useCallback(
    (event) => {
      event.preventDefault();
      release();
    },
    [release]
  );

  const handlePointerCancel = useCallback(
    (event) => {
      event.preventDefault();
      release();
    },
    [release]
  );

  const handleLostPointerCapture = useCallback(() => {
    release();
  }, [release]);

  const handleContextMenu = useCallback((event) => {
    event.preventDefault();
  }, []);

  return (
    <button
      type="button"
      className={className}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      onContextMenu={handleContextMenu}
    >
      {label}
    </button>
  );
}

function TouchControls({ enabled, mapping, labels, onButtonChange }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const stickRef = useRef(null);
  const stickPointerIdRef = useRef(null);
  const activeDirectionsRef = useRef({
    up: false,
    down: false,
    left: false,
    right: false,
  });

  const releaseAll = useCallback(() => {
    stickPointerIdRef.current = null;
    setKnob({ x: 0, y: 0 });
    activeDirectionsRef.current = { up: false, down: false, left: false, right: false };

    const buttonIds = [
      mapping?.up,
      mapping?.down,
      mapping?.left,
      mapping?.right,
      mapping?.select,
      mapping?.start,
      mapping?.a,
      mapping?.b,
      mapping?.c,
      mapping?.x,
      mapping?.y,
      mapping?.z,
    ];

    for (const buttonId of buttonIds) {
      if (buttonId === undefined || buttonId === null) {
        continue;
      }
      onButtonChange(buttonId, false);
    }
  }, [mapping, onButtonChange]);

  const buttons = useMemo(
    () => [
      { id: mapping?.x, label: labels?.x || "X", className: "touchButton touchButton--x" },
      { id: mapping?.y, label: labels?.y || "Y", className: "touchButton touchButton--y" },
      { id: mapping?.z, label: labels?.z || "Z", className: "touchButton touchButton--z" },
      { id: mapping?.a, label: labels?.a || "A", className: "touchButton touchButton--a" },
      { id: mapping?.b, label: labels?.b || "B", className: "touchButton touchButton--b" },
      { id: mapping?.c, label: labels?.c || "C", className: "touchButton touchButton--c" },
    ],
    [labels, mapping]
  );

  const updateDirections = useCallback(
    (next) => {
      const prev = activeDirectionsRef.current;
      const changed =
        prev.up !== next.up ||
        prev.down !== next.down ||
        prev.left !== next.left ||
        prev.right !== next.right;
      if (!changed) {
        return;
      }

      activeDirectionsRef.current = next;

      let directionChangedToTrue = false;
      if (!prev.up && next.up) directionChangedToTrue = true;
      if (!prev.down && next.down) directionChangedToTrue = true;
      if (!prev.left && next.left) directionChangedToTrue = true;
      if (!prev.right && next.right) directionChangedToTrue = true;

      if (directionChangedToTrue && typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(10);
      }

      onButtonChange(mapping.up, next.up);
      onButtonChange(mapping.down, next.down);
      onButtonChange(mapping.left, next.left);
      onButtonChange(mapping.right, next.right);
    },
    [mapping, onButtonChange]
  );

  const clearStick = useCallback(() => {
    stickPointerIdRef.current = null;
    setKnob({ x: 0, y: 0 });
    updateDirections({ up: false, down: false, left: false, right: false });
  }, [updateDirections]);

  const updateStickFromEvent = useCallback(
    (event) => {
      const element = stickRef.current;
      if (!element) {
        return;
      }

      const pos = getPointerPosition(event);
      if (!pos) {
        return;
      }

      const rect = element.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const dx = pos.x - cx;
      const dy = pos.y - cy;

      const maxRadius = Math.max(18, Math.min(rect.width, rect.height) * 0.35);
      const distance = Math.hypot(dx, dy);
      const scale = distance > maxRadius && distance > 0 ? maxRadius / distance : 1;

      const nx = dx * scale;
      const ny = dy * scale;
      setKnob({ x: nx, y: ny });

      const threshold = Math.max(10, maxRadius * 0.35);
      const left = nx < -threshold;
      const right = nx > threshold;
      const up = ny < -threshold;
      const down = ny > threshold;

      updateDirections({ up, down, left, right });
    },
    [updateDirections]
  );

  const handleStickPointerDown = useCallback(
    (event) => {
      if (!enabled) {
        return;
      }
      event.preventDefault();
      stickPointerIdRef.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
      updateStickFromEvent(event);
    },
    [enabled, updateStickFromEvent]
  );

  const handleStickPointerMove = useCallback(
    (event) => {
      if (!enabled) {
        return;
      }
      if (stickPointerIdRef.current == null || stickPointerIdRef.current !== event.pointerId) {
        return;
      }
      event.preventDefault();
      updateStickFromEvent(event);
    },
    [enabled, updateStickFromEvent]
  );

  const handleStickPointerUp = useCallback(
    (event) => {
      if (!enabled) {
        return;
      }
      if (stickPointerIdRef.current == null || stickPointerIdRef.current !== event.pointerId) {
        return;
      }
      event.preventDefault();
      clearStick();
    },
    [clearStick, enabled]
  );

  const handleStickPointerCancel = useCallback(
    (event) => {
      event.preventDefault();
      clearStick();
    },
    [clearStick]
  );

  const handleStickLostCapture = useCallback(() => {
    clearStick();
  }, [clearStick]);

  const handleContextMenu = useCallback((event) => {
    event.preventDefault();
  }, []);

  useEffect(() => {
    if (!enabled) {
      releaseAll();
    }
  }, [enabled, releaseAll]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        releaseAll();
      }
    };

    window.addEventListener("blur", releaseAll);
    window.addEventListener("pagehide", releaseAll);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("blur", releaseAll);
      window.removeEventListener("pagehide", releaseAll);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, releaseAll]);

  if (!enabled) {
    return null;
  }

  return (
    <div className="touchControls" aria-label="Touch controls">
      <div className="touchControls__left touchControls__group">
        <div
          className="touchStick"
          ref={stickRef}
          onPointerDown={handleStickPointerDown}
          onPointerMove={handleStickPointerMove}
          onPointerUp={handleStickPointerUp}
          onPointerCancel={handleStickPointerCancel}
          onLostPointerCapture={handleStickLostCapture}
          onContextMenu={handleContextMenu}
          role="application"
          aria-label="D-pad stick"
        >
          <div className="touchStick__base" />
          <div
            className="touchStick__knob"
            style={{
              transform: `translate3d(${clamp(knob.x, -60, 60)}px, ${clamp(
                knob.y,
                -60,
                60
              )}px, 0)`,
            }}
          />
        </div>
      </div>

      <div className="touchControls__center touchControls__group">
        <TouchButton
          label={labels?.select || "Select"}
          className="touchMetaButton"
          buttonId={mapping.select}
          onButtonChange={onButtonChange}
        />
        <TouchButton
          label={labels?.start || "Start"}
          className="touchMetaButton touchMetaButton--primary"
          buttonId={mapping.start}
          onButtonChange={onButtonChange}
        />
      </div>

      <div className="touchControls__right touchControls__group">
        <div className="touchFaceButtons" aria-label="Face buttons">
          {buttons.map((button) => (
            <TouchButton
              key={button.label}
              label={button.label}
              className={button.className}
              buttonId={button.id}
              onButtonChange={onButtonChange}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default TouchControls;
