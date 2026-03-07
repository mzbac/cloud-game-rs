import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { RTC_DATA_CHANNEL_LABELS } from "./generatedRtcLabels";

const captured = vi.hoisted(() => ({
  inputLoopConfig: null,
  lastPeerConnection: null,
}));

vi.mock("./inputLoop", () => ({
  startInputLoop: (config) => {
    captured.inputLoopConfig = config;
    return () => {};
  },
}));

vi.mock("./videoStallDetector", () => ({
  startVideoStallDetector: () => () => {},
}));

import { startWebRtcGameSession } from "./gameSessionEngine";

class FakeMediaStream {
  #tracks = [];

  addTrack(track) {
    this.#tracks.push(track);
  }

  getTracks() {
    return this.#tracks;
  }
}

class FakePeerConnection {
  connectionState = "connected";
  iceConnectionState = "connected";
  signalingState = "stable";
  remoteDescription = null;
  localDescription = null;

  onconnectionstatechange = null;
  ontrack = null;
  ondatachannel = null;
  onicecandidate = null;
  oniceconnectionstatechange = null;
  onsignalingstatechange = null;

  constructor() {
    captured.lastPeerConnection = this;
  }

  close() {
    this.connectionState = "closed";
  }

  setRemoteDescription = vi.fn(async (desc) => {
    this.remoteDescription = desc;
  });
  createAnswer = vi.fn(async () => {
    return { type: "answer", sdp: "" };
  });
  setLocalDescription = vi.fn(async (desc) => {
    this.localDescription = desc;
  });
  addIceCandidate = vi.fn(async () => {});
}

describe("startWebRtcGameSession input plumbing", () => {
  const originalPeerConnection = globalThis.RTCPeerConnection;
  const originalMediaStream = globalThis.MediaStream;

  beforeEach(() => {
    captured.inputLoopConfig = null;
    captured.lastPeerConnection = null;
    globalThis.RTCPeerConnection = FakePeerConnection;
    globalThis.MediaStream = FakeMediaStream;
  });

  afterEach(() => {
    globalThis.RTCPeerConnection = originalPeerConnection;
    globalThis.MediaStream = originalMediaStream;
  });

  it("sends the 2-byte Uint8Array packet provided by inputLoop", () => {
    const cleanup = startWebRtcGameSession({
      conn: null,
      workerID: "worker-1",
      remoteVideoRef: { current: null },
      joypadKeys: [0],
      keyboardCodesRef: { current: new Set() },
      keyboardMappingRef: { current: {} },
      gamepadMappingRef: { current: {} },
      touchStateRef: { current: {} },
      externalInputMaskRef: { current: 0 },
      setConnectionState: vi.fn(),
      setHasMedia: vi.fn(),
      setVideoStalled: vi.fn(),
      setAudioStatus: vi.fn(),
      resumeAudioRef: { current: null },
    });

    expect(captured.inputLoopConfig).not.toBeNull();
    expect(typeof captured.inputLoopConfig.sendInputViaDataChannel).toBe("function");

    const inputChannel = {
      label: RTC_DATA_CHANNEL_LABELS.GAME_INPUT,
      readyState: "open",
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };

    expect(captured.lastPeerConnection).not.toBeNull();
    captured.lastPeerConnection.ondatachannel({ channel: inputChannel });

    const packetValue = 0x1234;
    const inputPacket = new Uint8Array([0x34, 0x12]);
    const ok = captured.inputLoopConfig.sendInputViaDataChannel(inputPacket, packetValue);
    expect(ok).toBe(true);

    expect(inputChannel.send).toHaveBeenCalledTimes(1);
    const sent = inputChannel.send.mock.calls[0][0];
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(Array.from(sent)).toEqual([0x34, 0x12]);

    cleanup();
  });
});

class FakeWebSocketConnection {
  static OPEN = 1;
  readyState = FakeWebSocketConnection.OPEN;

  #listeners = new Map();

  addEventListener(type, handler) {
    if (!this.#listeners.has(type)) {
      this.#listeners.set(type, new Set());
    }
    this.#listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.#listeners.get(type)?.delete(handler);
  }

  send() {}

  emit(type, event) {
    for (const handler of this.#listeners.get(type) || []) {
      handler(event);
    }
  }
}

describe("startWebRtcGameSession ICE candidate ordering", () => {
  const originalPeerConnection = globalThis.RTCPeerConnection;
  const originalMediaStream = globalThis.MediaStream;
  const originalWebSocket = globalThis.WebSocket;
  const originalRTCSessionDescription = globalThis.RTCSessionDescription;
  const originalRTCIceCandidate = globalThis.RTCIceCandidate;

  const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    captured.lastPeerConnection = null;
    globalThis.RTCPeerConnection = FakePeerConnection;
    globalThis.MediaStream = FakeMediaStream;
    globalThis.WebSocket = FakeWebSocketConnection;
    globalThis.RTCSessionDescription = class RTCSessionDescription {
      constructor(desc) {
        Object.assign(this, desc);
      }
    };
    globalThis.RTCIceCandidate = class RTCIceCandidate {
      constructor(candidate) {
        Object.assign(this, candidate);
      }
    };
  });

  afterEach(() => {
    globalThis.RTCPeerConnection = originalPeerConnection;
    globalThis.MediaStream = originalMediaStream;
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCSessionDescription = originalRTCSessionDescription;
    globalThis.RTCIceCandidate = originalRTCIceCandidate;
  });

  it("queues candidates until the offer is applied", async () => {
    const conn = new FakeWebSocketConnection();
    const cleanup = startWebRtcGameSession({
      conn,
      workerID: "worker-1",
      remoteVideoRef: { current: null },
      joypadKeys: [0],
      keyboardCodesRef: { current: new Set() },
      keyboardMappingRef: { current: {} },
      gamepadMappingRef: { current: {} },
      touchStateRef: { current: {} },
      externalInputMaskRef: { current: 0 },
      setConnectionState: vi.fn(),
      setHasMedia: vi.fn(),
      setVideoStalled: vi.fn(),
      setAudioStatus: vi.fn(),
      resumeAudioRef: { current: null },
    });

    expect(captured.lastPeerConnection).not.toBeNull();

    const candidateInit = {
      candidate: "candidate:0 1 UDP 2122252543 203.0.113.10 51372 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    conn.emit("message", {
      data: JSON.stringify({
        id: "candidate",
        data: btoa(JSON.stringify(candidateInit)),
        sessionID: "worker-1",
      }),
    });

    await flushPromises();
    expect(captured.lastPeerConnection.addIceCandidate).toHaveBeenCalledTimes(0);

    const offerInit = { type: "offer", sdp: "v=0\r\n" };
    conn.emit("message", {
      data: JSON.stringify({
        id: "offer",
        data: btoa(JSON.stringify(offerInit)),
        sessionID: "worker-1",
      }),
    });

    await flushPromises();
    expect(captured.lastPeerConnection.setRemoteDescription).toHaveBeenCalledTimes(1);
    expect(captured.lastPeerConnection.addIceCandidate).toHaveBeenCalledTimes(1);

    cleanup();
  });
});
