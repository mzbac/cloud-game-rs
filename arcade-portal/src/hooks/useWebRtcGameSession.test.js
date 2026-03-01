import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const captured = vi.hoisted(() => ({
  resumeFn: vi.fn(),
  cleanupFn: vi.fn(),
  lastArgs: null,
}));

vi.mock("./webrtc/gameSessionEngine", () => ({
  startWebRtcGameSession: (args) => {
    captured.lastArgs = args;
    args.setConnectionState("connected");
    args.setHasMedia(true);
    args.setVideoStalled(false);
    args.setAudioStatus("running");
    args.resumeAudioRef.current = captured.resumeFn;
    return captured.cleanupFn;
  },
}));

import { useWebRtcGameSession } from "./useWebRtcGameSession";

describe("useWebRtcGameSession", () => {
  it("starts the session effect, wires resumeAudio, and cleans up on rerender/unmount", async () => {
    captured.resumeFn.mockClear();
    captured.cleanupFn.mockClear();
    captured.lastArgs = null;

    const baseProps = {
      conn: { readyState: 1 },
      workerID: "worker-1",
      remoteVideoRef: { current: null },
      reconnectToken: "t0",
      joypadKeys: [0],
      keyboardCodesRef: { current: new Set() },
      keyboardMappingRef: { current: {} },
      gamepadMappingRef: { current: {} },
      touchStateRef: { current: {} },
      externalInputMaskRef: { current: 0 },
    };

    const { result, rerender, unmount } = renderHook((props) => useWebRtcGameSession(props), {
      initialProps: baseProps,
    });

    await waitFor(() => expect(result.current.connectionState).toBe("connected"));
    expect(result.current.hasMedia).toBe(true);
    expect(result.current.videoStalled).toBe(false);
    expect(result.current.audioStatus).toBe("running");
    expect(captured.lastArgs).not.toBeNull();
    expect(typeof captured.lastArgs.setConnectionState).toBe("function");
    expect(typeof captured.lastArgs.resumeAudioRef).toBe("object");

    act(() => {
      result.current.resumeAudio();
    });
    expect(captured.resumeFn).toHaveBeenCalledTimes(1);

    rerender({ ...baseProps, reconnectToken: "t1" });
    expect(captured.cleanupFn).toHaveBeenCalledTimes(1);

    unmount();
    expect(captured.cleanupFn).toHaveBeenCalledTimes(2);
  });
});

