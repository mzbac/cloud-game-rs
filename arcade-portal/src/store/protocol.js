import { SIGNALING_MESSAGE_IDS } from "./generatedMessageIds";

export { SIGNALING_MESSAGE_IDS };

const normalizeSignalingPath = (rawPath) => {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return "/ws";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

const readEnv = (key) => {
  if (typeof process !== "undefined" && process.env) {
    return process.env[key];
  }

  if (import.meta?.env && Object.prototype.hasOwnProperty.call(import.meta.env, key)) {
    return import.meta.env[key];
  }

  return undefined;
};

export const SIGNALING_PATH = normalizeSignalingPath(
  readEnv("REACT_APP_SIGNALING_PATH")
);
const resolveWindowUrlFallback = () => {
  if (typeof window === "undefined" || !window.location) {
    return "ws://localhost:8000";
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}`;
};

const FALLBACK_SIGNALING_URL = `${resolveWindowUrlFallback()}${SIGNALING_PATH}`;

const knownMessageIds = new Set(Object.values(SIGNALING_MESSAGE_IDS));

export const parseSignalMessage = (raw) => {
  if (raw == null) {
    return null;
  }

  const rawText = raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : raw;

  if (typeof rawText !== "string") {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  if (typeof parsed.id !== "string" || !knownMessageIds.has(parsed.id)) {
    return null;
  }

  return {
    id: parsed.id,
    data: typeof parsed.data === "string" ? parsed.data : "",
    sessionID:
      typeof parsed.sessionID === "string"
        ? parsed.sessionID
        : typeof parsed.session_id === "string"
          ? parsed.session_id
          : undefined,
  };
};

export const buildSignalingMessage = ({ id, data, sessionID }) => ({
  id,
  ...(data !== undefined ? { data } : {}),
  ...(sessionID !== undefined ? { sessionID } : {}),
});

export const redactUrlQueryParamForLog = (rawUrl, key) => {
  if (!rawUrl || typeof rawUrl !== "string" || !key || typeof key !== "string") {
    return "";
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, "[REDACTED]");
    }
    return parsed.toString();
  } catch {
    return rawUrl.replace(new RegExp(`([?&]${key}=)[^&#]*`, "g"), "$1[REDACTED]");
  }
};

export const resolveSignalingUrl = () => {
  const configuredRaw = readEnv("REACT_APP_SIGNALING_URL");
  const tokenRaw = readEnv("REACT_APP_SIGNALING_TOKEN");

  const configured = typeof configuredRaw === "string" ? configuredRaw.trim() : "";
  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";

  const baseUrl = (() => {
    if (!configured) {
      return FALLBACK_SIGNALING_URL;
    }

    if (/^wss?:\/\//i.test(configured)) {
      return configured;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";

    if (configured.startsWith("/")) {
      return `${protocol}://${window.location.host}${configured}`;
    }

    if (configured.includes("/")) {
      return `${protocol}://${configured.replace(/\/+$/, "")}`;
    }

    return `${protocol}://${configured.replace(/\/+$/, "")}${SIGNALING_PATH}`;
  })();

  if (!token) {
    return baseUrl;
  }

  try {
    const parsed = new URL(baseUrl);
    if (!parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", token);
    }
    return parsed.toString();
  } catch {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
  }
};

export const redactSignalingUrlForLog = (url) => redactUrlQueryParamForLog(url, "token");
