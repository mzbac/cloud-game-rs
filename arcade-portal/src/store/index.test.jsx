import React, { useContext } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const captured = vi.hoisted(() => ({
  config: null,
  close: vi.fn(),
}));

vi.mock("./protocol", () => ({
  resolveSignalingUrl: vi.fn(() => "ws://example/ws"),
  resolveSnapshotUrl: vi.fn(() => "http://example/snapshot"),
  redactSignalingUrlForLog: vi.fn((url) => url),
}));

vi.mock("./signalConnection", () => ({
  createSignalConnection: vi.fn((config) => {
    captured.config = config;
    return { close: captured.close };
  }),
}));

vi.mock("../utils/log", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { AppDataContext, AppDataProvider } from "./index.jsx";

describe("AppDataProvider", () => {
  beforeEach(() => {
    captured.config = null;
    captured.close.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          games: { "room-1": "ssriders" },
          playerCountsByRoom: { "room-1": 2 },
        }),
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses snapshot polling on the home route without opening a websocket", async () => {
    captured.config = null;

    let latestState = null;

    function CaptureState() {
      const { state } = useContext(AppDataContext);
      latestState = state;
      return null;
    }

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppDataProvider>
          <CaptureState />
        </AppDataProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://example/snapshot", { cache: "no-store" }));
    expect(captured.config).toBeNull();
    await waitFor(() => {
      expect(latestState.conn).toBeNull();
      expect(latestState.games).toEqual({ "room-1": "ssriders" });
      expect(latestState.playerCountsByRoom).toEqual({ "room-1": 2 });
    });
  });

  it("creates a signaling connection on the game route and updates state via callbacks", async () => {
    let latestState = null;

    function CaptureState() {
      const { state } = useContext(AppDataContext);
      latestState = state;
      return null;
    }

    const { unmount } = render(
      <MemoryRouter initialEntries={["/game/room-1"]}>
        <AppDataProvider>
          <CaptureState />
        </AppDataProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(captured.config).not.toBeNull());
    expect(captured.config.url).toBe("ws://example/ws");
    expect(captured.config.heartbeatMs).toBe(15000);

    const fakeConn = { readyState: 1 };
    act(() => {
      captured.config.onSocketChange(fakeConn);
    });
    await waitFor(() => expect(latestState.conn).toBe(fakeConn));

    const games = { a: 1 };
    act(() => {
      captured.config.onGames(games);
    });
    await waitFor(() => expect(latestState.games).toBe(games));

    act(() => {
      captured.config.onPlayerCount({ roomId: "room-1", count: "3" });
    });
    await waitFor(() => {
      expect(latestState.currentPlayersInRoom).toBe(3);
      expect(latestState.playerCountsByRoom).toEqual({ "room-1": 3 });
    });

    act(() => {
      captured.config.onPlayerCount({ roomId: "", count: "2" });
    });
    await waitFor(() => {
      expect(latestState.currentPlayersInRoom).toBe(2);
      expect(latestState.playerCountsByRoom).toEqual({ "room-1": 3 });
    });

    unmount();
    expect(captured.close).toHaveBeenCalledTimes(1);
  });
});
