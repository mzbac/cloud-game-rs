import { fromEvent, interval, animationFrame } from "rxjs";
import { map, filter } from "rxjs/operators";

const INPUT_TICK_MS = 1000 / 60;

export const startInputLoop = ({
  joypadKeys,
  keyboardCodesRef,
  keyboardMappingRef,
  gamepadMappingRef,
  touchStateRef,
  externalInputMaskRef,
  getPrimaryGamepad,
  isGamepadBindingPressed,
  sendInputViaDataChannel,
  sendInputViaSignal,
  requestAudioPlayback,
}) => {
  const keyState = {};

  const suppressDefault = (event) => {
    if (keyboardCodesRef.current && keyboardCodesRef.current.has(event.code)) {
      event.preventDefault();
    }
  };

  const keydown$ = fromEvent(document, "keydown").pipe(
    filter((event) => keyboardCodesRef.current && keyboardCodesRef.current.has(event.code)),
    map((event) => {
      suppressDefault(event);
      return (keyState[event.code] = true);
    })
  );

  const keyup$ = fromEvent(document, "keyup").pipe(
    filter((event) => keyboardCodesRef.current && keyboardCodesRef.current.has(event.code)),
    map((event) => {
      suppressDefault(event);
      return (keyState[event.code] = false);
    })
  );

  const keydownSub = keydown$.subscribe();
  const keyupSub = keyup$.subscribe();

  const inputPacket = new Uint8Array(2);
  let lastInputPacketValue = null;
  const handler = interval(INPUT_TICK_MS, animationFrame).subscribe(() => {
    let keyboardBitmap = 0;
    let gamepadBitmap = 0;
    let touchBitmap = 0;
    const pad = getPrimaryGamepad();
    const activeGamepadMap = gamepadMappingRef.current || {};
    const activeKeyMap = keyboardMappingRef.current || {};

    for (let i = 0; i < joypadKeys.length; i++) {
      const index = joypadKeys[i];
      const rawMappedKeys = activeKeyMap[index];
      const mappedKeyCodes = Array.isArray(rawMappedKeys)
        ? rawMappedKeys
        : typeof rawMappedKeys === "string"
          ? [rawMappedKeys]
          : [];
      if (mappedKeyCodes.some((code) => keyState[code])) {
        keyboardBitmap |= 1 << index;
      }

      const bindings = Array.isArray(activeGamepadMap[index]) ? activeGamepadMap[index] : [];
      if (pad && bindings.some((binding) => isGamepadBindingPressed(binding, pad))) {
        gamepadBitmap |= 1 << index;
      }

      if (touchStateRef.current[index]) {
        touchBitmap |= 1 << index;
      }
    }

    const externalMask = Number(externalInputMaskRef?.current) || 0;
    const packetValue =
      (keyboardBitmap | gamepadBitmap | touchBitmap | (externalMask & 0xffff)) & 0xffff;
    if (lastInputPacketValue === null && packetValue === 0) {
      lastInputPacketValue = 0;
      return;
    }
    if (packetValue === lastInputPacketValue) {
      return;
    }
    inputPacket[0] = packetValue & 0xff;
    inputPacket[1] = (packetValue >>> 8) & 0xff;

    const sent =
      sendInputViaDataChannel(inputPacket, packetValue) || sendInputViaSignal(packetValue);
    if (!sent) {
      requestAudioPlayback(true);
      return;
    }

    lastInputPacketValue = packetValue;
    if (packetValue !== 0) {
      requestAudioPlayback(true);
    }
  });

  return () => {
    handler.unsubscribe();
    keydownSub.unsubscribe();
    keyupSub.unsubscribe();
  };
};
