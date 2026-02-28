import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";

const parseArgs = (argv) => {
  const args = {
    url: "http://127.0.0.1:8080",
    durationSeconds: 60,
    sampleIntervalMs: 1000,
    outDir: process.env.WEBRTC_BENCH_OUTDIR || "./webrtc-bench-results",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--url" && argv[i + 1]) {
      args.url = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--duration" && argv[i + 1]) {
      args.durationSeconds = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (token === "--interval" && argv[i + 1]) {
      args.sampleIntervalMs = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (token === "--out" && argv[i + 1]) {
      args.outDir = argv[i + 1];
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(args.durationSeconds) || args.durationSeconds <= 0) {
    throw new Error(`invalid --duration: ${args.durationSeconds}`);
  }
  if (!Number.isFinite(args.sampleIntervalMs) || args.sampleIntervalMs < 200) {
    throw new Error(`invalid --interval: ${args.sampleIntervalMs}`);
  }

  return args;
};

const summarizeSamples = (samples) => {
  if (!samples.length) {
    return { ok: false, reason: "no samples collected" };
  }

  const first = samples[0];
  const last = samples[samples.length - 1];

  const pickInboundVideo = (sample) =>
    sample.stats.find(
      (entry) =>
        entry?.type === "inbound-rtp" &&
        (entry.kind === "video" || entry.mediaType === "video")
    );

  const pickSelectedCandidatePair = (sample) =>
    sample.stats.find(
      (entry) =>
        entry?.type === "candidate-pair" &&
        (entry.selected === true || entry.nominated === true) &&
        entry.state === "succeeded"
    );

  const inboundFirst = pickInboundVideo(first) || null;
  const inboundLast = pickInboundVideo(last) || null;
  const pairLast = pickSelectedCandidatePair(last) || null;

  const delta = (key) => {
    const start = Number(inboundFirst?.[key]);
    const end = Number(inboundLast?.[key]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return null;
    }
    return end - start;
  };

  const packetsLostDelta = delta("packetsLost");
  const packetsReceivedDelta = delta("packetsReceived");
  const framesDroppedDelta = delta("framesDropped");
  const framesDecodedDelta = delta("framesDecoded");
  const freezeCountDelta = delta("freezeCount");
  const totalFreezesDurationDelta = delta("totalFreezesDuration");
  const jitterBufferDelayDelta = delta("jitterBufferDelay");
  const jitterBufferEmittedCountDelta = delta("jitterBufferEmittedCount");

  const lossRate =
    packetsLostDelta != null &&
    packetsReceivedDelta != null &&
    packetsLostDelta + packetsReceivedDelta > 0
      ? packetsLostDelta / (packetsLostDelta + packetsReceivedDelta)
      : null;

  const avgJitterBufferDelaySeconds =
    jitterBufferDelayDelta != null &&
    jitterBufferEmittedCountDelta != null &&
    jitterBufferEmittedCountDelta > 0
      ? jitterBufferDelayDelta / jitterBufferEmittedCountDelta
      : null;

  return {
    ok: true,
    sampleCount: samples.length,
    durationSeconds: (last.tMs - first.tMs) / 1000,
    inboundVideo: {
      packetsLostDelta,
      packetsReceivedDelta,
      lossRate,
      framesDroppedDelta,
      framesDecodedDelta,
      freezeCountDelta,
      totalFreezesDurationDelta,
      avgJitterBufferDelaySeconds,
      lastJitterSeconds:
        inboundLast && Number.isFinite(Number(inboundLast.jitter))
          ? Number(inboundLast.jitter)
          : null,
    },
    selectedCandidatePair: pairLast
      ? {
          currentRoundTripTime:
            Number.isFinite(Number(pairLast.currentRoundTripTime))
              ? Number(pairLast.currentRoundTripTime)
              : null,
          availableOutgoingBitrate:
            Number.isFinite(Number(pairLast.availableOutgoingBitrate))
              ? Number(pairLast.availableOutgoingBitrate)
              : null,
          availableIncomingBitrate:
            Number.isFinite(Number(pairLast.availableIncomingBitrate))
              ? Number(pairLast.availableIncomingBitrate)
              : null,
          localCandidateId: pairLast.localCandidateId || null,
          remoteCandidateId: pairLast.remoteCandidateId || null,
        }
      : null,
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const runId = startedAt.toISOString().replaceAll(":", "").replaceAll(".", "");
  const outDir = path.resolve(args.outDir, runId);

  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const baseUrl = args.url.replace(/\/$/, "");
    await page.goto(`${baseUrl}/?webrtcDebug=1`, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector(".gameCard", { timeout: 60_000 });
    await page.click(".gameCard");

    await page.waitForURL(/\/game\//, { timeout: 60_000 });
    const gameUrl = page.url();
    if (!gameUrl.includes("webrtcDebug=") && !gameUrl.includes("webrtcStats=")) {
      const withDebug = `${gameUrl}${gameUrl.includes("?") ? "&" : "?"}webrtcDebug=1`;
      await page.goto(withDebug, { waitUntil: "domcontentloaded" });
    }

    await page.waitForSelector("#remoteVideos", { timeout: 60_000 });
    await page.waitForFunction(() => {
      const api = window.__cloudArcadeWebRtc;
      return Boolean(api && typeof api.getStats === "function");
    }, { timeout: 60_000 });

    await page.waitForFunction(() => {
      const v = document.querySelector("#remoteVideos");
      return Boolean(v && v.readyState >= 2 && v.videoWidth > 0);
    }, { timeout: 60_000 });

    const samples = [];
    const startWall = Date.now();
    const durationMs = args.durationSeconds * 1000;
    while (Date.now() - startWall < durationMs) {
      const tMs = Date.now() - startWall;
      const { stats, pcState, videoQuality } = await page.evaluate(async () => {
        const api = window.__cloudArcadeWebRtc;
        const stats = api ? await api.getStats() : [];
        const pc = api?.pc;
        const pcState = pc
          ? {
              connectionState: pc.connectionState,
              iceConnectionState: pc.iceConnectionState,
              signalingState: pc.signalingState,
            }
          : null;
        const v = document.querySelector("#remoteVideos");
        const videoQuality =
          v && typeof v.getVideoPlaybackQuality === "function"
            ? v.getVideoPlaybackQuality()
            : null;
        return { stats, pcState, videoQuality };
      });

      samples.push({ tMs, stats, pcState, videoQuality });
      await page.waitForTimeout(args.sampleIntervalMs);
    }

    const summary = summarizeSamples(samples);

    await writeFile(
      path.join(outDir, "samples.json"),
      JSON.stringify(samples, null, 2)
    );
    await writeFile(
      path.join(outDir, "summary.json"),
      JSON.stringify(summary, null, 2)
    );

    process.stdout.write(JSON.stringify({ outDir, summary }, null, 2));
    process.stdout.write("\n");
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
};

await main();
