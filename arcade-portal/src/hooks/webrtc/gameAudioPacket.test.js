import { describe, it, expect } from "vitest";

import { GAME_AUDIO_PACKET_SPEC } from "./generatedGameAudioPacketSpec";
import { parseGameAudioPacket } from "./gameAudioPacket";

describe("parseGameAudioPacket", () => {
  it("parses v1 packets regardless of field order", () => {
    const raw = `${GAME_AUDIO_PACKET_SPEC.KIND}|sr=44100|ch=2|v=${GAME_AUDIO_PACKET_SPEC.VERSION}|payload`;
    expect(parseGameAudioPacket(raw, 48000)).toEqual({
      sampleRate: 44100,
      channels: 2,
      encoded: "payload",
    });
  });

  it("rejects packets with missing/incorrect version", () => {
    const wrong = `${GAME_AUDIO_PACKET_SPEC.KIND}|v=999|sr=48000|ch=2|payload`;
    expect(parseGameAudioPacket(wrong, 48000)).toBeNull();
    const missing = `${GAME_AUDIO_PACKET_SPEC.KIND}|sr=48000|ch=2|payload`;
    expect(parseGameAudioPacket(missing, 48000)).toBeNull();
  });

  it("falls back to legacy audio-pcm16le packets", () => {
    const legacy = "audio-pcm16le|sr=22050|payload";
    expect(parseGameAudioPacket(legacy, 48000)).toEqual({
      sampleRate: 22050,
      channels: GAME_AUDIO_PACKET_SPEC.CHANNELS,
      encoded: "payload",
    });
  });

  it("uses fallback sampleRate when the packet value is invalid", () => {
    const raw = `${GAME_AUDIO_PACKET_SPEC.KIND}|v=${GAME_AUDIO_PACKET_SPEC.VERSION}|sr=bad|ch=2|payload`;
    expect(parseGameAudioPacket(raw, 12345)).toEqual({
      sampleRate: 12345,
      channels: 2,
      encoded: "payload",
    });
  });
});

