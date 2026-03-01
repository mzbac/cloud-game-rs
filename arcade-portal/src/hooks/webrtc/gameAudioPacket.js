import { GAME_AUDIO_PACKET_SPEC } from "./generatedGameAudioPacketSpec";

const parseLegacyAudioPacket = (raw, fallbackSampleRate) => {
  if (!raw.startsWith("audio-pcm16le|")) {
    return null;
  }

  const parts = raw.replace("audio-pcm16le|", "").split("|", 2);
  if (parts.length < 2 || !parts[1]) {
    return null;
  }

  const parsedRate = Number.parseInt(parts[0].replace("sr=", ""), 10);
  const sampleRate =
    Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : fallbackSampleRate;

  return {
    sampleRate,
    channels: GAME_AUDIO_PACKET_SPEC.CHANNELS,
    encoded: parts[1],
  };
};

export const parseGameAudioPacket = (raw, fallbackSampleRate) => {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  if (raw.startsWith(`${GAME_AUDIO_PACKET_SPEC.KIND}|`)) {
    const parts = raw.split("|");
    if (parts.length < 5) {
      return null;
    }

    const payload = parts[parts.length - 1];
    if (!payload) {
      return null;
    }

    let version = null;
    let sampleRate = fallbackSampleRate;
    let channels = GAME_AUDIO_PACKET_SPEC.CHANNELS;
    for (const field of parts.slice(1, -1)) {
      if (field.startsWith("v=")) {
        const parsed = Number.parseInt(field.replace("v=", ""), 10);
        version = Number.isFinite(parsed) ? parsed : null;
      } else if (field.startsWith("sr=")) {
        const parsed = Number.parseInt(field.replace("sr=", ""), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          sampleRate = parsed;
        }
      } else if (field.startsWith("ch=")) {
        const parsed = Number.parseInt(field.replace("ch=", ""), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          channels = parsed;
        }
      }
    }

    if (version !== GAME_AUDIO_PACKET_SPEC.VERSION) {
      return null;
    }

    return {
      sampleRate,
      channels,
      encoded: payload,
    };
  }

  return parseLegacyAudioPacket(raw, fallbackSampleRate);
};

