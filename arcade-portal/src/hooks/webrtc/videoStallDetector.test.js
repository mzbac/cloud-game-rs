import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { startVideoStallDetector } from "./videoStallDetector";

describe("startVideoStallDetector", () => {
  const originalDescriptor =
    Object.getOwnPropertyDescriptor(document, "visibilityState") ||
    Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalDescriptor) {
      Object.defineProperty(document, "visibilityState", originalDescriptor);
    }
  });

  const makeReadyVideo = () => ({
    readyState: 2,
    videoWidth: 640,
    currentTime: 0,
  });

  it("marks the video stalled after ~3s without progress", () => {
    const remoteVideo = makeReadyVideo();
    const remoteVideoRef = { current: remoteVideo };
    const setVideoStalled = vi.fn();
    const cleanup = startVideoStallDetector({
      remoteVideoRef,
      isPeerConnected: () => true,
      setVideoStalled,
    });

    vi.advanceTimersByTime(3000);
    expect(setVideoStalled).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(setVideoStalled).toHaveBeenCalledWith(true);

    remoteVideo.currentTime = 1;
    vi.advanceTimersByTime(1000);
    expect(setVideoStalled).toHaveBeenLastCalledWith(false);

    cleanup();
  });

  it("does not run while the document is hidden", () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const setVideoStalled = vi.fn();
    const cleanup = startVideoStallDetector({
      remoteVideoRef: { current: makeReadyVideo() },
      isPeerConnected: () => true,
      setVideoStalled,
    });

    vi.advanceTimersByTime(5000);
    expect(setVideoStalled).not.toHaveBeenCalled();

    cleanup();
  });
});

