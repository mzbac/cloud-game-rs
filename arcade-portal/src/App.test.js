import {
  buildSignalingMessage,
  parseSignalMessage,
  resolveSignalingUrl,
} from "./store/protocol";

describe("protocol helpers", () => {
  test("builds normalized signaling message", () => {
    expect(
      buildSignalingMessage({
        id: "offer",
        data: "abc",
        sessionID: "session-id",
      })
    ).toEqual({
      id: "offer",
      data: "abc",
      sessionID: "session-id",
    });
  });

  test("parses strict message schema", () => {
    expect(parseSignalMessage('{"id":"offer","data":"x","sessionID":"s"}')).toEqual({
      id: "offer",
      data: "x",
      sessionID: "s",
    });
  });

  test("drops invalid message IDs", () => {
    expect(parseSignalMessage('{"id":"bad","data":"x"}')).toBeNull();
  });

  test("resolves relative websocket URL", () => {
    const previousSignalingUrl = process.env.REACT_APP_SIGNALING_URL;
    const previousLocation = window.location;
    Object.defineProperty(window, "location", {
      value: {
        protocol: "http:",
        host: "example.com",
      },
      writable: true,
    });

    process.env.REACT_APP_SIGNALING_URL = "/ws";
    expect(resolveSignalingUrl()).toBe("ws://example.com/ws");

    process.env.REACT_APP_SIGNALING_URL = "/signal";
    expect(resolveSignalingUrl()).toBe("ws://example.com/signal");

    if (previousSignalingUrl === undefined) {
      delete process.env.REACT_APP_SIGNALING_URL;
    } else {
      process.env.REACT_APP_SIGNALING_URL = previousSignalingUrl;
    }
    window.location = previousLocation;
  });
});
