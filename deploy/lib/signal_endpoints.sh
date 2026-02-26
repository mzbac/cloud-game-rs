#!/usr/bin/env bash

arcade_normalize_signal_path() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    printf '/ws'
    return
  fi

  if [[ "$raw" == /* ]]; then
    printf '%s' "$raw"
    return
  fi

  printf '/%s' "$raw"
}

arcade_default_browser_signal_path() {
  local raw="${SIGNAL_BROWSER_PATH:-/ws}"
  arcade_normalize_signal_path "$raw"
}

arcade_default_worker_signal_path() {
  local raw="${SIGNAL_WORKER_PATH:-/wws}"
  arcade_normalize_signal_path "$raw"
}

arcade_build_ws_url() {
  local host="$1"
  local port="$2"
  local path="$(arcade_normalize_signal_path "${3:-}")"
  printf 'ws://%s:%s%s' "$host" "$port" "$path"
}
