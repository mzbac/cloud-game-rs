import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createAudioPlaybackController } from "./audioPlayback";

describe("createAudioPlaybackController", () => {
  const originalAudioContext = window.AudioContext;
  const originalWebkitAudioContext = window.webkitAudioContext;

  beforeEach(() => {
    window.AudioContext = undefined;
    window.webkitAudioContext = undefined;
  });

  afterEach(() => {
    window.AudioContext = originalAudioContext;
    window.webkitAudioContext = originalWebkitAudioContext;
  });

  it("reports blocked/unavailable when AudioContext is not supported", () => {
    const setAudioStatus = vi.fn();
    const resumeAudioRef = { current: null };
    const controller = createAudioPlaybackController({ setAudioStatus, resumeAudioRef });

    controller.requestAudioPlayback(false);
    expect(setAudioStatus).toHaveBeenLastCalledWith("blocked");

    controller.requestAudioPlayback(true);
    expect(setAudioStatus).toHaveBeenLastCalledWith("unavailable");

    expect(typeof resumeAudioRef.current).toBe("function");
  });
});

