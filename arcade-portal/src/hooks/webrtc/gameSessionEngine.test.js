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

  async setRemoteDescription() {}
  async createAnswer() {
    return { type: "answer", sdp: "" };
  }
  async setLocalDescription() {}
  async addIceCandidate() {}
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

