import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createSignalConnection } from "./signalConnection";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent = [];

  #listeners = new Map();

  constructor(url) {
    this.url = url;
  }

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

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code: 1000, reason: "closed" });
  }
}

describe("createSignalConnection", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("requests games on open and on heartbeat", () => {
    let socket = null;
    const onSocketChange = vi.fn((next) => {
      socket = next;
    });

    const conn = createSignalConnection({
      url: "ws://example/ws",
      urlForLog: "ws://example/ws",
      heartbeatMs: 1000,
      onSocketChange,
      onGames: vi.fn(),
      onPlayerCount: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    });

    expect(onSocketChange).toHaveBeenCalled();
    expect(socket).toBeInstanceOf(FakeWebSocket);

    socket.readyState = FakeWebSocket.OPEN;
    socket.dispatch("open");
    expect(socket.sent.length).toBe(1);
    expect(JSON.parse(socket.sent[0])).toEqual({ id: "getGames" });

    vi.advanceTimersByTime(1000);
    expect(socket.sent.length).toBe(2);
    expect(JSON.parse(socket.sent[1])).toEqual({ id: "getGames" });

    conn.close();
  });

  it("parses games payloads and forwards to onGames", () => {
    let socket = null;
    const onGames = vi.fn();

    const conn = createSignalConnection({
      url: "ws://example/ws",
      urlForLog: "ws://example/ws",
      heartbeatMs: 1000,
      onSocketChange: (next) => {
        socket = next;
      },
      onGames,
      onPlayerCount: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    });

    socket.readyState = FakeWebSocket.OPEN;
    socket.dispatch("message", {
      data: JSON.stringify({
        id: "games",
        data: JSON.stringify({ a: 1 }),
      }),
    });

    expect(onGames).toHaveBeenCalledWith({ a: 1 });
    conn.close();
  });

  it("forwards updatePlayerCount messages", () => {
    let socket = null;
    const onPlayerCount = vi.fn();

    const conn = createSignalConnection({
      url: "ws://example/ws",
      urlForLog: "ws://example/ws",
      heartbeatMs: 1000,
      onSocketChange: (next) => {
        socket = next;
      },
      onGames: vi.fn(),
      onPlayerCount,
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    });

    socket.readyState = FakeWebSocket.OPEN;
    socket.dispatch("message", {
      data: JSON.stringify({
        id: "updatePlayerCount",
        sessionID: "room-1",
        data: "7",
      }),
    });

    expect(onPlayerCount).toHaveBeenCalledWith({ roomId: "room-1", count: "7" });
    conn.close();
  });

  it("closes the socket and stops the heartbeat when closed by the app", () => {
    let socket = null;
    const onSocketChange = vi.fn((next) => {
      socket = next;
    });

    const conn = createSignalConnection({
      url: "ws://example/ws",
      urlForLog: "ws://example/ws",
      heartbeatMs: 1000,
      onSocketChange,
      onGames: vi.fn(),
      onPlayerCount: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    });

    socket.readyState = FakeWebSocket.OPEN;
    socket.dispatch("open");
    expect(socket.sent.length).toBe(1);

    const socketRef = socket;
    conn.close();
    expect(onSocketChange).toHaveBeenLastCalledWith(null);
    expect(socketRef.readyState).toBe(FakeWebSocket.CLOSED);

    const sentBefore = socketRef.sent.length;
    vi.advanceTimersByTime(2000);
    expect(socketRef.sent.length).toBe(sentBefore);
  });

  it("re-requests games when the page is shown again", () => {
    let socket = null;
    const onSocketChange = vi.fn((next) => {
      socket = next;
    });

    const conn = createSignalConnection({
      url: "ws://example/ws",
      urlForLog: "ws://example/ws",
      heartbeatMs: 60_000,
      onSocketChange,
      onGames: vi.fn(),
      onPlayerCount: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    });

    socket.readyState = FakeWebSocket.OPEN;
    socket.dispatch("open");
    socket.sent.length = 0;

    window.dispatchEvent(new Event("pageshow"));
    expect(socket.sent.length).toBe(1);
    expect(JSON.parse(socket.sent[0])).toEqual({ id: "getGames" });

    conn.close();
  });

  it("reconnects when the initial websocket connection stalls", () => {
    let socket = null;
    const onSocketChange = vi.fn((next) => {
      socket = next;
    });

    const conn = createSignalConnection({
      url: "ws://example/ws",
      urlForLog: "ws://example/ws",
      heartbeatMs: 1000,
      onSocketChange,
      onGames: vi.fn(),
      onPlayerCount: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    });

    const firstSocket = socket;
    expect(firstSocket).toBeInstanceOf(FakeWebSocket);
    expect(firstSocket.readyState).toBe(FakeWebSocket.CONNECTING);

    vi.advanceTimersByTime(8000);
    vi.advanceTimersByTime(1000);

    expect(socket).toBeInstanceOf(FakeWebSocket);
    expect(socket).not.toBe(firstSocket);

    conn.close();
  });

  it("does not reconnect on pageshow while the websocket is closing", () => {
    let socket = null;
    const onSocketChange = vi.fn((next) => {
      socket = next;
    });

    const conn = createSignalConnection({
      url: "ws://example/ws",
      urlForLog: "ws://example/ws",
      heartbeatMs: 60_000,
      onSocketChange,
      onGames: vi.fn(),
      onPlayerCount: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    });

    const firstSocket = socket;
    firstSocket.readyState = FakeWebSocket.CLOSING;

    window.dispatchEvent(new Event("pageshow"));
    expect(onSocketChange).toHaveBeenCalledTimes(1);
    expect(socket).toBe(firstSocket);

    conn.close();
  });
});
