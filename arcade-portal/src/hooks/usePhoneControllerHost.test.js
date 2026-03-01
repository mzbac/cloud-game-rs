import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { usePhoneControllerHost } from "./usePhoneControllerHost";

class FakeConn {
  sent = [];
  readyState = 0;
  #listeners = new Map();

  addEventListener(type, handler) {
    const list = this.#listeners.get(type) || new Set();
    list.add(handler);
    this.#listeners.set(type, list);
  }

  removeEventListener(type, handler) {
    this.#listeners.get(type)?.delete(handler);
  }

  dispatch(type, event = {}) {
    for (const handler of this.#listeners.get(type) || []) {
      handler(event);
    }
  }

  send(payload) {
    this.sent.push(payload);
  }
}

describe("usePhoneControllerHost", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.WebSocket = { OPEN: 1 };
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = OriginalWebSocket;
  });

  const message = (payload) =>
    ({
      data: JSON.stringify(payload),
    });

  it("registers the host and updates pairing state on controllerReady", async () => {
    const conn = new FakeConn();
    conn.readyState = 1;
    const onEnableAudio = vi.fn();

    const { result, unmount } = renderHook(() =>
      usePhoneControllerHost({ conn, workerID: "worker-1", onEnableAudio })
    );

    await act(async () => {});
    expect(conn.sent.length).toBe(1);
    expect(JSON.parse(conn.sent[0])).toEqual({ id: "controllerHost", sessionID: "worker-1" });

    act(() => {
      conn.dispatch(
        "message",
        message({
          id: "controllerReady",
          data: JSON.stringify({ code: "ABCD" }),
        })
      );
    });

    expect(result.current.pairingCode).toBe("ABCD");
    expect(result.current.controllerUrl).toContain("/controller/ABCD");
    expect(result.current.controllerUrl).toContain("worker=worker-1");

    unmount();
  });

  it("tracks joined/left controllers and forwards audio enable", async () => {
    const conn = new FakeConn();
    conn.readyState = 1;
    const onEnableAudio = vi.fn();

    const { result, unmount } = renderHook(() =>
      usePhoneControllerHost({ conn, workerID: "worker-1", onEnableAudio })
    );

    await act(async () => {});
    expect(conn.sent.length).toBe(1);

    act(() => {
      conn.dispatch("message", message({ id: "controllerJoined", sessionID: "ctrl-1" }));
    });
    expect(result.current.connectedControllers).toBe(1);

    act(() => {
      conn.dispatch("message", message({ id: "controllerJoined", sessionID: "ctrl-1" }));
      conn.dispatch("message", message({ id: "controllerJoined", sessionID: "ctrl-2" }));
    });
    expect(result.current.connectedControllers).toBe(2);

    act(() => {
      conn.dispatch("message", message({ id: "controllerLeft", sessionID: "ctrl-1" }));
    });
    expect(result.current.connectedControllers).toBe(1);

    act(() => {
      conn.dispatch("message", message({ id: "controllerAudio" }));
    });
    expect(onEnableAudio).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refreshPairing();
    });
    expect(conn.sent.length).toBe(2);
    expect(JSON.parse(conn.sent[1])).toEqual({ id: "controllerHost", sessionID: "worker-1" });

    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(conn.sent.length).toBe(3);

    unmount();
  });
});
