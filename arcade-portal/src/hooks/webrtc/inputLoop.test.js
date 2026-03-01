import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("rxjs", async () => {
  const actual = await vi.importActual("rxjs");
  return {
    ...actual,
    // Use a timer-based scheduler to keep the input loop testable under fake timers.
    animationFrame: actual.asyncScheduler,
  };
});

import { startInputLoop } from "./inputLoop";

describe("startInputLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createDefaultConfig = (overrides = {}) => ({
    joypadKeys: [0],
    keyboardCodesRef: { current: new Set(["KeyA"]) },
    keyboardMappingRef: { current: { 0: "KeyA" } },
    gamepadMappingRef: { current: {} },
    touchStateRef: { current: {} },
    externalInputMaskRef: { current: 0 },
    getPrimaryGamepad: () => null,
    isGamepadBindingPressed: () => false,
    sendInputViaDataChannel: vi.fn(() => true),
    sendInputViaSignal: vi.fn(() => false),
    requestAudioPlayback: vi.fn(),
    ...overrides,
  });

  it("suppresses the initial zero packet", () => {
    const config = createDefaultConfig({
      keyboardMappingRef: { current: { 0: "KeyA" } },
    });

    const cleanup = startInputLoop(config);
    vi.advanceTimersByTime(20);

    expect(config.sendInputViaDataChannel).not.toHaveBeenCalled();
    expect(config.sendInputViaSignal).not.toHaveBeenCalled();
    expect(config.requestAudioPlayback).not.toHaveBeenCalled();

    cleanup();
  });

  it("sends a 2-byte packet when a mapped key is pressed", () => {
    const config = createDefaultConfig();

    const cleanup = startInputLoop(config);
    vi.advanceTimersByTime(20);
    expect(config.sendInputViaDataChannel).not.toHaveBeenCalled();

    const down = new KeyboardEvent("keydown", { code: "KeyA", cancelable: true });
    document.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);

    vi.advanceTimersByTime(20);

    expect(config.sendInputViaDataChannel).toHaveBeenCalledTimes(1);
    const [packet, packetValue] = config.sendInputViaDataChannel.mock.calls[0];
    expect(packetValue).toBe(1);
    expect(packet).toBeInstanceOf(Uint8Array);
    expect(Array.from(packet)).toEqual([1, 0]);
    expect(config.requestAudioPlayback).toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(40);
    expect(config.sendInputViaDataChannel).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("falls back to signaling when the data channel send fails", () => {
    const sendInputViaDataChannel = vi.fn(() => false);
    const sendInputViaSignal = vi.fn(() => true);
    const requestAudioPlayback = vi.fn();
    const config = createDefaultConfig({
      sendInputViaDataChannel,
      sendInputViaSignal,
      requestAudioPlayback,
    });

    const cleanup = startInputLoop(config);
    vi.advanceTimersByTime(20);

    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", cancelable: true }));
    vi.advanceTimersByTime(20);

    expect(sendInputViaDataChannel).toHaveBeenCalledTimes(1);
    expect(sendInputViaSignal).toHaveBeenCalledTimes(1);
    expect(sendInputViaSignal).toHaveBeenCalledWith(1);
    expect(requestAudioPlayback).toHaveBeenCalledWith(true);

    cleanup();
  });
});

