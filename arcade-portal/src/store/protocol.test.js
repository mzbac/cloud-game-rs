import {
  parseSignalMessage,
  redactUrlQueryParamForLog,
  resolveSignalingUrl,
} from "./protocol";

const setEnv = (key, value) => {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
};

describe("protocol helpers", () => {
  const originalUrl = process.env.REACT_APP_SIGNALING_URL;
  const originalToken = process.env.REACT_APP_SIGNALING_TOKEN;
  const originalPath = process.env.REACT_APP_SIGNALING_PATH;

  afterEach(() => {
    setEnv("REACT_APP_SIGNALING_URL", originalUrl);
    setEnv("REACT_APP_SIGNALING_TOKEN", originalToken);
    setEnv("REACT_APP_SIGNALING_PATH", originalPath);
  });

  describe("redactUrlQueryParamForLog", () => {
    it("redacts token in valid URLs", () => {
      expect(
        redactUrlQueryParamForLog("ws://example.com/ws?token=secret&x=1", "token")
      ).toBe("ws://example.com/ws?token=%5BREDACTED%5D&x=1");
    });

    it("redacts token in non-URL strings", () => {
      expect(redactUrlQueryParamForLog("not-a-url?token=secret&x=1", "token")).toBe(
        "not-a-url?token=[REDACTED]&x=1"
      );
    });
  });

  describe("resolveSignalingUrl", () => {
    it("returns configured absolute ws URL as-is when no token", () => {
      setEnv("REACT_APP_SIGNALING_URL", "ws://example.com/ws");
      setEnv("REACT_APP_SIGNALING_TOKEN", "");
      expect(resolveSignalingUrl()).toBe("ws://example.com/ws");
    });

    it("does not duplicate the token query param", () => {
      setEnv("REACT_APP_SIGNALING_URL", "ws://example.com/ws?token=already");
      setEnv("REACT_APP_SIGNALING_TOKEN", "new");
      expect(resolveSignalingUrl()).toBe("ws://example.com/ws?token=already");
    });

    it("resolves relative paths against the current host", () => {
      setEnv("REACT_APP_SIGNALING_URL", "/ws");
      setEnv("REACT_APP_SIGNALING_TOKEN", "abc");
      expect(resolveSignalingUrl()).toBe(
        `ws://${window.location.host}/ws?token=abc`
      );
    });
  });

  describe("parseSignalMessage", () => {
    it("accepts legacy session_id", () => {
      expect(
        parseSignalMessage('{"id":"offer","data":"x","session_id":"legacy-id"}')
      ).toEqual({
        id: "offer",
        data: "x",
        sessionID: "legacy-id",
      });
    });

    it("returns null for unknown message IDs", () => {
      expect(parseSignalMessage('{"id":"unknown","data":"x"}')).toBeNull();
    });
  });
});
