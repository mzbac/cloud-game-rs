import React, { useContext } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";

const captured = vi.hoisted(() => ({
  config: null,
  close: vi.fn(),
}));

vi.mock("./protocol", () => ({
  resolveSignalingUrl: vi.fn(() => "ws://example/ws"),
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
  it("creates a signaling connection and updates state via callbacks", async () => {
    captured.config = null;
    captured.close.mockClear();

    let latestState = null;

    function CaptureState() {
      const { state } = useContext(AppDataContext);
      latestState = state;
      return null;
    }

    const { unmount } = render(
      <AppDataProvider>
        <CaptureState />
      </AppDataProvider>
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

