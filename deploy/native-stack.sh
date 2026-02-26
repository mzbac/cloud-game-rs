#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./native-stack.sh <command> [--env-file FILE] [--no-build] [--skip-proxy]

Commands:
  up       - Build required artifacts, start services, and wait for health checks.
  down     - Stop all running services.
  restart  - down then up.
  status   - Show running status.
  logs     - Tail all service logs.
  help     - Show this help.

Defaults:
  Env file: deploy/.env.native.example (or env supplied by --env-file)
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INVOKE_DIR="$(pwd)"
source "${SCRIPT_DIR}/lib/signal_endpoints.sh"
RUNTIME_DIR="${SCRIPT_DIR}/.native-runtime"
RUNTIME_LOGS_DIR="${RUNTIME_DIR}/logs"
RUNTIME_PIDS_DIR="${RUNTIME_DIR}/pids"
mkdir -p "$RUNTIME_DIR" "$RUNTIME_LOGS_DIR" "$RUNTIME_PIDS_DIR"

usage_error() {
  echo "$1"
  usage
  exit 1
}

require_cmd() {
  local bin=$1
  if ! command -v "$bin" >/dev/null 2>&1; then
    usage_error "required command missing: $bin"
  fi
}

parse_port() {
  local addr=$1
  if [[ "$addr" =~ ([0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi
  echo "8000"
}

if [[ -d "$HOME/.cargo/bin" ]]; then
  PATH="$HOME/.cargo/bin:$PATH"
fi

require_cmd curl

COMMAND="${1:-}"
if [[ -z "$COMMAND" ]]; then
  usage
  exit 1
fi
shift || true

case "$COMMAND" in
  -h|--help|help)
    usage
    exit 0
    ;;
  up|down|restart|status|logs)
    ;;
  *)
    usage_error "unknown command: $COMMAND"
    ;;
esac

ENV_FILE="${SCRIPT_DIR}/.env.native.example"
NO_BUILD=0
SKIP_PROXY=0

while (( "$#" > 0 )); do
  case "$1" in
    --env-file)
      if [[ "$#" -lt 2 || -z "${2:-}" ]]; then
        usage_error "--env-file requires a path"
      fi
      ENV_FILE="$2"
      shift 2
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --skip-proxy)
      SKIP_PROXY=1
      shift
      ;;
    *)
      usage_error "unknown argument: $1"
      ;;
  esac
done

resolve_env_file_path() {
  local candidate="$1"

  if [[ -z "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  if [[ "$candidate" == /* ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  local base
  for base in "$INVOKE_DIR" "$PROJECT_ROOT" "$SCRIPT_DIR"; do
    if [[ -f "${base}/${candidate}" ]]; then
      printf '%s\n' "${base}/${candidate}"
      return
    fi
  done

  printf '%s\n' "$candidate"
}

ENV_FILE="$(resolve_env_file_path "$ENV_FILE")"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
elif [[ "$ENV_FILE" != "${SCRIPT_DIR}/.env.native.example" ]]; then
  echo "warning: env file not found: $ENV_FILE"
  echo "continuing with defaults"
fi

: "${SIGNAL_SERVICE_DIR:=arcade-signal}"
: "${SIGNAL_SERVICE_BINARY:=signal}"
: "${WORKER_SERVICE_DIR:=arcade-worker}"
: "${WORKER_SERVICE_BINARY:=worker}"
: "${SIGNAL_ADDR:=:8000}"
: "${SIGNAL_HOST_PORT:=}"
: "${WORKER_HEALTH_ADDR:=:8081}"
: "${WORKER_HEALTH_HOST_PORT:=}"
: "${PORTAL_PORT:=8080}"
: "${PORTAL_BUILD_DIR:=$PROJECT_ROOT/arcade-portal/build}"
: "${REACT_APP_SIGNALING_URL:=$(arcade_default_browser_signal_path)}"
: "${WORKER_SIGNAL_URL:=}"
: "${SIGNAL_LOG_LEVEL:=info}"
: "${WORKER_LOG_LEVEL:=info}"
: "${PORTAL_HEALTH_PATH:=/healthz}"
: "${PORTAL_PUBLIC_HOST:=}"
: "${PORTAL_PUBLIC_PORT:=}"
: "${WORKER_STARTUP_WAIT_SECONDS:=120}"
: "${CADDY_DOWNLOAD_URL:=https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_linux_amd64.tar.gz}"

SIGNAL_LISTEN_PORT="$(parse_port "${SIGNAL_ADDR}")"
: "${SIGNAL_HOST_PORT:=${SIGNAL_LISTEN_PORT}}"
: "${WORKER_HEALTH_PORT:=$(parse_port "${WORKER_HEALTH_ADDR}")}"
: "${WORKER_HEALTH_HOST_PORT:=${WORKER_HEALTH_PORT}}"
: "${WORKER_SIGNAL_URL:=$(arcade_build_ws_url "127.0.0.1" "${SIGNAL_LISTEN_PORT}" "$(arcade_default_worker_signal_path)")}"

if (( SKIP_PROXY == 0 )); then
  NATIVE_USE_PROXY=1
else
  NATIVE_USE_PROXY=0
  if [[ -z "${PORTAL_PUBLIC_HOST}" ]]; then
    PORTAL_PUBLIC_HOST="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [[ -z "${PORTAL_PUBLIC_HOST}" ]]; then
    PORTAL_PUBLIC_HOST="127.0.0.1"
  fi
  : "${PORTAL_PUBLIC_PORT:=$PORTAL_PORT}"
  if [[ -z "${REACT_APP_SIGNALING_URL}" || "${REACT_APP_SIGNALING_URL}" == "$(arcade_default_browser_signal_path)" ]]; then
    REACT_APP_SIGNALING_URL="$(arcade_build_ws_url "${PORTAL_PUBLIC_HOST}" "${PORTAL_PUBLIC_PORT}" "$(arcade_default_browser_signal_path)")"
  fi
fi

SIGNAL_BIN="$PROJECT_ROOT/$SIGNAL_SERVICE_DIR/target/release/$SIGNAL_SERVICE_BINARY"
WORKER_BIN="$PROJECT_ROOT/$WORKER_SERVICE_DIR/target/release/$WORKER_SERVICE_BINARY"
PORTAL_BUILD_DIR="${PORTAL_BUILD_DIR/#\~/$HOME}"
if [[ -n "$PORTAL_BUILD_DIR" && "$PORTAL_BUILD_DIR" != /* ]]; then
  PORTAL_BUILD_DIR="$PROJECT_ROOT/$PORTAL_BUILD_DIR"
fi
RUNTIME_CADDY_FILE="${RUNTIME_DIR}/Caddyfile"
RUNTIME_CADDY_BIN="${RUNTIME_DIR}/caddy"

LOG_SIGNAL="${RUNTIME_LOGS_DIR}/signal.log"
LOG_WORKER="${RUNTIME_LOGS_DIR}/worker.log"
LOG_PORTAL="${RUNTIME_LOGS_DIR}/portal.log"
PID_SIGNAL="${RUNTIME_PIDS_DIR}/signal.pid"
PID_WORKER="${RUNTIME_PIDS_DIR}/worker.pid"
PID_PORTAL="${RUNTIME_PIDS_DIR}/portal.pid"
PID_SIGNAL_META="${RUNTIME_PIDS_DIR}/signal.meta"
PID_WORKER_META="${RUNTIME_PIDS_DIR}/worker.meta"
PID_PORTAL_META="${RUNTIME_PIDS_DIR}/portal.meta"

write_pid_metadata() {
  local pid_file=$1
  local meta_file=$2
  local pid=$3
  local marker=$4
  printf '%s\n' "$pid" > "$pid_file"
  {
    printf 'pid=%s\n' "$pid"
    printf 'marker=%s\n' "$marker"
  } > "$meta_file"
}

read_meta_marker() {
  local meta_file=$1
  [[ -f "$meta_file" ]] || return 0
  sed -n 's/^marker=//p' "$meta_file" | head -n 1
}

pid_matches_marker() {
  local pid=$1
  local marker=$2
  if [[ -z "$marker" ]]; then
    return 0
  fi

  local args
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ -n "$args" ]] && [[ "$args" == *"$marker"* ]]
}

cleanup() {
  for pair in \
    "signal:$PID_SIGNAL:$PID_SIGNAL_META" \
    "worker:$PID_WORKER:$PID_WORKER_META" \
    "portal:$PID_PORTAL:$PID_PORTAL_META"
  do
    local name="${pair%%:*}"
    local rest="${pair#*:}"
    local pid_file="${rest%%:*}"
    local meta_file="${rest##*:}"
    if [[ -f "$pid_file" ]]; then
      local pid
      pid="$(cat "$pid_file")"
      if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
        local marker
        marker="$(read_meta_marker "$meta_file")"
        if ! pid_matches_marker "$pid" "$marker"; then
          echo "skipping stop for $name: pid $pid does not match expected marker"
          rm -f "$pid_file" "$meta_file"
          continue
        fi
        echo "stopping $name (pid $pid)"
        kill "$pid" || true
        timeout 8s bash -c "while kill -0 $pid 2>/dev/null; do sleep 0.2; done" || true
      fi
      rm -f "$pid_file" "$meta_file"
    fi
  done
}

is_running() {
  local pid_file=$1
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file")"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

wait_for_url() {
  local service_name=$1
  local url=$2
  local attempts=$3

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "$service_name is healthy"
      return 0
    fi
    sleep 1
  done
  echo "timeout waiting for $service_name at $url" >&2
  return 1
}

ensure_node_toolchain() {
  local node_bin=""
  local npm_bin=""
  if [[ -n "${NODE_BIN:-}" && -n "${NPM_BIN:-}" ]]; then
    if [[ -x "$NODE_BIN" && -x "$NPM_BIN" ]]; then
      return 0
    fi
  fi

  for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    "$HOME/.nvm/versions/node/v20.20.0/bin/node" \
    "$HOME/.nvm/versions/node/current/bin/node" \
  ; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      node_bin="$candidate"
      break
    fi
  done

  [[ -z "$node_bin" ]] && return 1
  npm_bin="${node_bin%/node}/npm"
  if [[ ! -x "$npm_bin" ]]; then
    npm_bin="$(dirname "$node_bin")/npm"
  fi
  [[ -x "$npm_bin" ]] || return 1

  NODE_BIN="$node_bin"
  NPM_BIN="$npm_bin"
  return 0
}

build_signal() {
  if (( NO_BUILD == 1 )); then
    [[ -x "$SIGNAL_BIN" ]] || usage_error "no-build requested and signal binary not found: $SIGNAL_BIN"
    return
  fi

  require_cmd cargo
  local cc="${CC:-}"
  local cxx="${CXX:-}"

  if [[ -z "$cc" ]]; then
    if command -v gcc >/dev/null 2>&1; then
      cc="gcc"
    elif command -v clang >/dev/null 2>&1; then
      cc="clang"
    else
      usage_error "no compiler found for Rust build (need CC/gcc/clang)"
    fi
  fi

  if [[ -z "$cxx" ]]; then
    if command -v clang >/dev/null 2>&1; then
      cxx="clang"
    elif command -v g++ >/dev/null 2>&1; then
      cxx="g++"
    else
      cxx="$cc"
    fi
  fi

  (cd "$PROJECT_ROOT/$SIGNAL_SERVICE_DIR" && CC="$cc" CXX="$cxx" cargo build --release --bin "$SIGNAL_SERVICE_BINARY")
}

build_worker() {
  if (( NO_BUILD == 1 )); then
    [[ -x "$WORKER_BIN" ]] || usage_error "no-build requested and worker binary not found: $WORKER_BIN"
    return
  fi

  require_cmd cargo
  local cc="${CC:-}"
  local cxx="${CXX:-}"

  if [[ -z "$cc" ]]; then
    if command -v gcc >/dev/null 2>&1; then
      cc="gcc"
    elif command -v clang >/dev/null 2>&1; then
      cc="clang"
    else
      usage_error "no compiler found for Rust build (need CC/gcc/clang)"
    fi
  fi

  if [[ -z "$cxx" ]]; then
    if command -v clang >/dev/null 2>&1; then
      cxx="clang"
    elif command -v g++ >/dev/null 2>&1; then
      cxx="g++"
    else
      cxx="$cc"
    fi
  fi

  (cd "$PROJECT_ROOT/$WORKER_SERVICE_DIR" && CC="$cc" CXX="$cxx" cargo build --release --bin "$WORKER_SERVICE_BINARY")
}

build_portal() {
  if (( NO_BUILD == 1 )) && [[ -f "$PORTAL_BUILD_DIR/index.html" ]]; then
    return
  fi

  if (( NO_BUILD == 1 )); then
    usage_error "no-build requested and portal build missing: $PORTAL_BUILD_DIR/index.html"
  fi

  if ! ensure_node_toolchain; then
    usage_error "node/npm not found. Install Node.js or prebuild portal into $PORTAL_BUILD_DIR and run with --no-build"
  fi

  if [[ ! -d "$PROJECT_ROOT/arcade-portal" ]]; then
    usage_error "portal source not found at $PROJECT_ROOT/arcade-portal"
  fi

  echo "building portal with REACT_APP_SIGNALING_URL=$REACT_APP_SIGNALING_URL"
  (cd "$PROJECT_ROOT/arcade-portal" && \
    REACT_APP_SIGNALING_URL="$REACT_APP_SIGNALING_URL" "$NPM_BIN" install --no-audit --no-fund >/tmp/arcade-portal-npm-install.log 2>&1 \
    && "$NPM_BIN" run build >/tmp/arcade-portal-build.log 2>&1)
}

build_if_needed() {
  build_signal
  build_worker
  build_portal
  mkdir -p "$PORTAL_BUILD_DIR"
  printf '{"status":"ok"}' > "$PORTAL_BUILD_DIR/healthz"
}

start_signal() {
  echo "starting signal"
  if ! [[ -x "$SIGNAL_BIN" ]]; then
    usage_error "signal binary is not executable: $SIGNAL_BIN"
  fi

  (
    cd "$PROJECT_ROOT/$SIGNAL_SERVICE_DIR" && \
    SIGNAL_ADDR="$SIGNAL_ADDR" \
    SIGNAL_STATIC_DIR="$PORTAL_BUILD_DIR" \
    SIGNAL_LOG_LEVEL="$SIGNAL_LOG_LEVEL" \
    "$SIGNAL_BIN"
  ) >> "$LOG_SIGNAL" 2>&1 &
  write_pid_metadata "$PID_SIGNAL" "$PID_SIGNAL_META" "$!" "$SIGNAL_BIN"
}

start_worker() {
  echo "starting worker"
  if ! [[ -x "$WORKER_BIN" ]]; then
    usage_error "worker binary is not executable: $WORKER_BIN"
  fi

  local -a worker_env=(
    "WORKER_SIGNAL_URL=$WORKER_SIGNAL_URL"
    "WORKER_HEALTH_ADDR=$WORKER_HEALTH_ADDR"
    "WORKER_LOG_LEVEL=$WORKER_LOG_LEVEL"
  )

  (
    cd "$PROJECT_ROOT/$WORKER_SERVICE_DIR" && \
    env "${worker_env[@]}" "$WORKER_BIN"
  ) >> "$LOG_WORKER" 2>&1 &
  write_pid_metadata "$PID_WORKER" "$PID_WORKER_META" "$!" "$WORKER_BIN"
}

ensure_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    CADDY_BIN="$(command -v caddy)"
    return 0
  fi
  if [[ -x "$RUNTIME_CADDY_BIN" ]]; then
    CADDY_BIN="$RUNTIME_CADDY_BIN"
    return 0
  fi

  local tmp_dir archive
  tmp_dir="$(mktemp -d)"
  archive="${tmp_dir}/caddy.tar.gz"
  echo "downloading caddy into $RUNTIME_CADDY_BIN"
  curl -fsSL "$CADDY_DOWNLOAD_URL" -o "$archive"
  tar -xzf "$archive" -C "$tmp_dir" caddy
  mv "$tmp_dir/caddy" "$RUNTIME_CADDY_BIN"
  chmod +x "$RUNTIME_CADDY_BIN"
  rm -rf "$tmp_dir"
  CADDY_BIN="$RUNTIME_CADDY_BIN"
}

start_proxy() {
  if (( NATIVE_USE_PROXY == 0 )); then
    require_cmd python3
    echo "starting static portal server (no proxy)"
    (cd "$PORTAL_BUILD_DIR" && python3 -m http.server "$PORTAL_PORT" --bind 0.0.0.0) >> "$LOG_PORTAL" 2>&1 &
    write_pid_metadata "$PID_PORTAL" "$PID_PORTAL_META" "$!" "python3 -m http.server ${PORTAL_PORT}"
    return
  fi

  ensure_caddy
  cat > "$RUNTIME_CADDY_FILE" <<EOF
{
  auto_https off
}

:${PORTAL_PORT} {
  route /healthz {
    respond "ok" 200
  }

  handle /ws* {
    reverse_proxy 127.0.0.1:${SIGNAL_LISTEN_PORT}
  }

  handle {
    root * ${PORTAL_BUILD_DIR}
    try_files {path} /index.html
    file_server
  }
}
EOF

  echo "starting caddy reverse proxy"
  "$CADDY_BIN" run --config "$RUNTIME_CADDY_FILE" >> "$LOG_PORTAL" 2>&1 &
  write_pid_metadata "$PID_PORTAL" "$PID_PORTAL_META" "$!" "$CADDY_BIN run --config $RUNTIME_CADDY_FILE"
}

stop_stack() {
  cleanup
}

status_stack() {
  if is_running "$PID_SIGNAL"; then
    echo "signal: running (pid $(cat "$PID_SIGNAL"))"
  else
    echo "signal: stopped"
  fi
  if is_running "$PID_WORKER"; then
    echo "worker: running (pid $(cat "$PID_WORKER"))"
  else
    echo "worker: stopped"
  fi
  if is_running "$PID_PORTAL"; then
    echo "portal: running (pid $(cat "$PID_PORTAL"))"
  else
    echo "portal: stopped"
  fi

  echo "urls:"
  if (( NATIVE_USE_PROXY == 1 )); then
    echo "- portal: http://127.0.0.1:${PORTAL_PORT}"
    echo "- signaling ws: http://127.0.0.1:${PORTAL_PORT}/ws"
  else
    echo "- portal: http://127.0.0.1:${PORTAL_PORT}"
    echo "- signaling ws: ${WORKER_SIGNAL_URL}"
  fi
}

follow_logs() {
  touch "$LOG_SIGNAL" "$LOG_WORKER" "$LOG_PORTAL"
  tail -F "$LOG_SIGNAL" "$LOG_WORKER" "$LOG_PORTAL"
}

start_stack() {
  build_if_needed
  stop_stack

  start_signal
  wait_for_url "signal" "http://127.0.0.1:${SIGNAL_HOST_PORT}/healthz" "$WORKER_STARTUP_WAIT_SECONDS"

  start_worker
  wait_for_url "worker" "http://127.0.0.1:${WORKER_HEALTH_HOST_PORT}/healthz" "$WORKER_STARTUP_WAIT_SECONDS"

  start_proxy
  wait_for_url "portal" "http://127.0.0.1:${PORTAL_PORT}${PORTAL_HEALTH_PATH}" "$WORKER_STARTUP_WAIT_SECONDS"

  echo "cloud stack started"
  status_stack
}

case "$COMMAND" in
  up)
    trap cleanup INT TERM
    start_stack
    ;;
  down)
    stop_stack
    ;;
  restart)
    stop_stack
    start_stack
    ;;
  status)
    status_stack
    ;;
  logs)
    follow_logs
    ;;
esac
