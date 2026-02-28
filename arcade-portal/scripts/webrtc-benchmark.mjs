import { chromium, firefox, webkit } from "playwright";

const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
};

const argv = parseArgs(process.argv.slice(2));

const urlRaw = typeof argv.url === "string" ? argv.url.trim() : "";
const url = urlRaw || "http://localhost:8080/";
const browserName =
  typeof argv.browser === "string" ? argv.browser.trim().toLowerCase() : "chromium";
const durationSec = Number.parseFloat(
  typeof argv.duration === "string" ? argv.duration : "20"
);
const sampleMs = Number.parseInt(typeof argv["sample-ms"] === "string" ? argv["sample-ms"] : "1000", 10);
const timeoutMs = Number.parseInt(typeof argv["timeout-ms"] === "string" ? argv["timeout-ms"] : "60000", 10);
const headless = argv.headless === false || argv.headless === "false" ? false : true;
const roomId = typeof argv.room === "string" && argv.room.trim() ? argv.room.trim() : null;

const browserTypes = { chromium, firefox, webkit };
const browserType = browserTypes[browserName];
if (!browserType) {
  throw new Error(`Unsupported --browser ${browserName}. Use chromium|firefox|webkit.`);
}
if (!Number.isFinite(durationSec) || durationSec <= 0) {
  throw new Error(`Invalid --duration ${argv.duration}.`);
}
if (!Number.isFinite(sampleMs) || sampleMs <= 0) {
  throw new Error(`Invalid --sample-ms ${argv["sample-ms"]}.`);
}

const computeSummary = ({ samples }) => {
  const valid = samples.filter((s) => s && s.inbound && typeof s.t === "number");
  const first = valid[0];
  const last = valid[valid.length - 1];

  const seconds = first && last ? (last.t - first.t) / 1000 : 0;
  const delta = (field) =>
    first && last && Number.isFinite(first.inbound?.[field]) && Number.isFinite(last.inbound?.[field])
      ? last.inbound[field] - first.inbound[field]
      : null;

  const bytesReceived = delta("bytesReceived");
  const framesDecoded = delta("framesDecoded");
  const framesDropped = delta("framesDropped");
  const packetsLost = delta("packetsLost");

  const bitrateKbps =
    bytesReceived != null && seconds > 0 ? (bytesReceived * 8) / seconds / 1000 : null;
  const fps = framesDecoded != null && seconds > 0 ? framesDecoded / seconds : null;
  const dropRate =
    framesDecoded != null && framesDropped != null && framesDecoded > 0
      ? framesDropped / framesDecoded
      : null;

  const rttSamples = samples
    .map((s) => s?.candidatePair?.currentRoundTripTime)
    .filter((v) => Number.isFinite(v) && v >= 0);
  const avgRttMs = rttSamples.length
    ? (rttSamples.reduce((sum, v) => sum + v, 0) / rttSamples.length) * 1000
    : null;

  const trackSamples = samples
    .map((s) => s?.track)
    .filter((t) => t && Number.isFinite(t.frameWidth) && Number.isFinite(t.frameHeight));
  const lastDims = trackSamples.length
    ? trackSamples[trackSamples.length - 1]
    : null;

  return {
    seconds,
    bitrateKbps,
    fps,
    dropRate,
    packetsLost,
    avgRttMs,
    frameWidth: lastDims?.frameWidth ?? null,
    frameHeight: lastDims?.frameHeight ?? null,
  };
};

const runOnce = async () => {
  const browser = await browserType.launch({
    headless,
    args:
      browserName === "chromium"
        ? ["--autoplay-policy=no-user-gesture-required"]
        : [],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    await page.addInitScript(() => {
      const bench = {
        start: performance.now(),
        pcs: [],
      };
      window.__webrtcBench = bench;
      const Original = window.RTCPeerConnection;
      if (!Original) return;
      function WrappedRTCPeerConnection(...args) {
        const pc = new Original(...args);
        try {
          window.__webrtcBench.pcs.push(pc);
        } catch {}
        return pc;
      }
      WrappedRTCPeerConnection.prototype = Original.prototype;
      Object.setPrototypeOf(WrappedRTCPeerConnection, Original);
      window.RTCPeerConnection = WrappedRTCPeerConnection;
    });

    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

    if (roomId) {
      const target = new URL(`/game/${roomId}`, url).toString();
      await page.goto(target, { waitUntil: "load", timeout: timeoutMs });
    } else {
      await page.waitForSelector(".gameCard", { timeout: timeoutMs });
      await page.evaluate(() => {
        if (window.__webrtcBench) {
          window.__webrtcBench.start = performance.now();
        }
      });
      await page.locator(".gameCard").first().click({ timeout: timeoutMs });
    }

    await page.waitForSelector("#remoteVideos", { timeout: timeoutMs });

    const timeToFirstFrameMs = await page.evaluate(async () => {
      const start = window.__webrtcBench?.start ?? performance.now();
      const video = document.querySelector("#remoteVideos");
      if (!video) return null;

      const waitForFirstFrame = () =>
        new Promise((resolve) => {
          const poll = () => {
            if (video.readyState >= 2 && video.videoWidth > 0) {
              if ("requestVideoFrameCallback" in video) {
                video.requestVideoFrameCallback((now) => resolve(now - start));
              } else {
                resolve(performance.now() - start);
              }
              return;
            }
            setTimeout(poll, 50);
          };
          poll();
        });

      return waitForFirstFrame();
    });

    const samples = [];
    const totalSamples = Math.max(2, Math.floor((durationSec * 1000) / sampleMs));
    for (let i = 0; i < totalSamples; i += 1) {
      const sample = await page.evaluate(async () => {
        const now = performance.now();
        const video = document.querySelector("#remoteVideos");
        const videoState = video
          ? {
              readyState: video.readyState,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
            }
          : null;

        const pc = window.__webrtcBench?.pcs?.[0];
        if (!pc) {
          return { t: now, video: videoState, pcState: null, inbound: null, candidatePair: null, track: null };
        }

        const stats = await pc.getStats();
        let inbound = null;
        let candidatePair = null;
        let track = null;
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "video") {
            inbound = report;
          }
          if (
            report.type === "candidate-pair" &&
            report.state === "succeeded" &&
            report.nominated
          ) {
            candidatePair = report;
          }
          if (report.type === "track" && report.kind === "video") {
            track = report;
          }
        });

        return {
          t: now,
          video: videoState,
          pcState: pc.connectionState,
          iceState: pc.iceConnectionState,
          inbound: inbound
            ? {
                bytesReceived: inbound.bytesReceived ?? null,
                packetsLost: inbound.packetsLost ?? null,
                framesDecoded: inbound.framesDecoded ?? null,
                framesDropped: inbound.framesDropped ?? null,
                jitter: inbound.jitter ?? null,
              }
            : null,
          candidatePair: candidatePair
            ? {
                currentRoundTripTime: candidatePair.currentRoundTripTime ?? null,
                availableIncomingBitrate: candidatePair.availableIncomingBitrate ?? null,
              }
            : null,
          track: track
            ? {
                frameWidth: track.frameWidth ?? null,
                frameHeight: track.frameHeight ?? null,
                framesPerSecond: track.framesPerSecond ?? null,
              }
            : null,
        };
      });

      samples.push(sample);
      await page.waitForTimeout(sampleMs);
    }

    return {
      roomId,
      finalUrl: page.url(),
      timeToFirstFrameMs,
      samples,
      summary: computeSummary({ samples }),
    };
  } finally {
    await browser.close();
  }
};

const result = await runOnce();
process.stdout.write(
  `${JSON.stringify(
    {
      config: { url, browser: browserName, durationSec, sampleMs, headless, roomId },
      result,
    },
    null,
    2
  )}\n`
);

