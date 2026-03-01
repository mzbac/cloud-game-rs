#!/bin/sh

set -eu

SIGNAL_HOST="${SIGNAL_BACKEND_HOST:-signal}"
SIGNAL_PORT="${SIGNAL_BACKEND_PORT:-8000}"
SIGNAL_HEALTH_PATH="${SIGNAL_HEALTH_PATH:-/healthz}"
SIGNAL_HEALTH_URL="http://${SIGNAL_HOST}:${SIGNAL_PORT}${SIGNAL_HEALTH_PATH}"

WAIT_SECONDS="${PORTAL_WAIT_FOR_SIGNAL_TIMEOUT_SECONDS:-120}"

echo "[portal] waiting for signal health: ${SIGNAL_HEALTH_URL}"

start_ts="$(date +%s)"
while true; do
  if curl -fsS "${SIGNAL_HEALTH_URL}" >/dev/null 2>&1; then
    echo "[portal] signal is healthy"
    break
  fi

  now_ts="$(date +%s)"
  elapsed="$((now_ts - start_ts))"
  if [ "$elapsed" -ge "$WAIT_SECONDS" ]; then
    echo "[portal] timed out waiting for signal after ${WAIT_SECONDS}s" >&2
    exit 1
  fi

  sleep 1
done

exec nginx -g "daemon off;"
