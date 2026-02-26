import { logError, logWarn } from "../../utils/log";

const DEFAULT_AUDIO_SAMPLE_RATE = 48000;

const createAudioContext = (preferredSampleRate, setAudioStatus) => {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  try {
    const ctx = new AudioContextCtor({ sampleRate: preferredSampleRate });
    ctx.onstatechange = () => {
      setAudioStatus(ctx.state || "unknown");
    };
    return ctx;
  } catch (err) {
    logWarn("[audio] audio context sampleRate not supported, falling back", err);
  }

  try {
    const ctx = new AudioContextCtor();
    ctx.onstatechange = () => {
      setAudioStatus(ctx.state || "unknown");
    };
    return ctx;
  } catch (err) {
    logError("[audio] failed to create audio context", err);
    return null;
  }
};

const decodeBase64 = (value) => {
  const bytes = atob(value);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes.charCodeAt(i);
  }
  return out;
};

const decodeTextFromBytes = (bytes, decoder) => {
  if (decoder) {
    return decoder.decode(bytes);
  }

  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
};

const decodeAudioPacket = (raw, decoder) => {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Blob) {
    return raw.text();
  }
  if (raw instanceof ArrayBuffer) {
    return decodeTextFromBytes(new Uint8Array(raw), decoder);
  }
  if (ArrayBuffer.isView(raw)) {
    return decodeTextFromBytes(
      new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
      decoder
    );
  }
  if (raw === null || raw === undefined) {
    return null;
  }
  return null;
};

export const createAudioPlaybackController = ({ setAudioStatus, resumeAudioRef }) => {
  const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
  let audioContext;
  let nextAudioStartTime = 0;
  let audioSampleRate = DEFAULT_AUDIO_SAMPLE_RATE;
  let audioResumeInProgress;

  const requestAudioPlayback = (allowCreate) => {
    if (!audioContext || audioContext.state === "closed") {
      if (!allowCreate) {
        setAudioStatus("blocked");
        return;
      }

      audioContext = createAudioContext(audioSampleRate, setAudioStatus);
      if (!audioContext) {
        setAudioStatus("unavailable");
        return;
      }
      nextAudioStartTime = 0;
      audioResumeInProgress = undefined;
    }

    if (audioContext.state === "running") {
      audioResumeInProgress = undefined;
      setAudioStatus("running");
      return;
    }

    if (!allowCreate) {
      setAudioStatus(audioContext.state || "unknown");
      return;
    }

    if (!audioResumeInProgress) {
      setAudioStatus(audioContext.state || "unknown");
      audioResumeInProgress = audioContext
        .resume()
        .then(() => {
          nextAudioStartTime = 0;
        })
        .catch((err) => {
          logError("[audio] resume failed", err);
        })
        .finally(() => {
          setAudioStatus(audioContext?.state || "unknown");
          audioResumeInProgress = undefined;
        });
    }
  };

  const resumeAudioFromGesture = () => requestAudioPlayback(true);
  if (resumeAudioRef) {
    resumeAudioRef.current = resumeAudioFromGesture;
  }

  const playAudioChunk = (encoded, sampleRate) => {
    if (!encoded || !audioContext) {
      return;
    }
    if (audioContext.state !== "running") {
      return;
    }
    const bytes = decodeBase64(encoded);
    if (bytes.length === 0 || bytes.length % 2 !== 0) {
      return;
    }
    if (sampleRate && sampleRate !== audioSampleRate) {
      audioSampleRate = sampleRate;
    }

    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    const frameCount = Math.floor(samples.length / 2);
    if (frameCount === 0) {
      return;
    }

    const buffer = audioContext.createBuffer(
      2,
      frameCount,
      sampleRate || audioContext.sampleRate
    );
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frameCount; i++) {
      left[i] = Math.max(-1, Math.min(1, samples[i * 2] / 32767));
      right[i] = Math.max(-1, Math.min(1, samples[i * 2 + 1] / 32767));
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    const now = audioContext.currentTime;
    if (
      !Number.isFinite(nextAudioStartTime) ||
      nextAudioStartTime < now - 0.25 ||
      nextAudioStartTime > now + 1.0
    ) {
      nextAudioStartTime = now;
    }
    const startTime = Math.max(now + 0.02, nextAudioStartTime);
    source.start(startTime);
    nextAudioStartTime = startTime + buffer.duration;
  };

  const handleAudioMessage = async (rawData) => {
    requestAudioPlayback(false);

    let raw;
    try {
      raw = await decodeAudioPacket(rawData, decoder);
    } catch (err) {
      logWarn("[audio] failed to decode audio packet", err);
      return;
    }

    if (!raw || typeof raw !== "string" || !raw.startsWith("audio-pcm16le|")) {
      return;
    }
    const parts = raw.replace("audio-pcm16le|", "").split("|", 2);
    if (parts.length < 2 || !parts[1]) {
      return;
    }

    const sampleRate = Number.parseInt(parts[0].replace("sr=", ""), 10);
    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : audioSampleRate;
    if (rate !== audioSampleRate) {
      audioSampleRate = rate;
    }
    playAudioChunk(parts[1], rate);
  };

  const cleanup = () => {
    if (resumeAudioRef) {
      resumeAudioRef.current = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
  };

  return {
    requestAudioPlayback,
    resumeAudioFromGesture,
    handleAudioMessage,
    cleanup,
  };
};

