#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./container-stack.sh <command> [--env-file FILE] [--no-build]

Commands:
  up       - Build images (unless --no-build), run networked services, and wait for health checks.
  build    - Build all service images only.
  down     - Stop and remove stack containers.
  restart  - down then up.
  status   - Show container list.
  logs     - Tail logs for all stack containers.
  help     - Show this help.

Defaults:
  Env file: deploy/.env.production
  Network: cloud-arcade
  Default service names:
    signal
    worker
    portal
  Prefix via CONTAINER_NAME_PREFIX (optional)
Worker networking:
  WORKER_NETWORK_MODE=host uses host networking (recommended for LAN WebRTC stability)
Worker games:
  WORKER_GAMES=auto (default) discovers ROMs in arcade-worker/assets/games.
  WORKER_DEFAULT_GAME=/path/to/game.zip runs a single worker.
  WORKER_GAMES=/path/to/game1.zip,/path/to/game2.zip runs one worker per game.
To force docker runtime:
  CONTAINER_RUNTIME_CHOICE=docker
  export CONTAINER_RUNTIME_CHOICE
EOF
}

resolve_dockerfile_path() {
  local candidate="$1"
  if [[ -z "$candidate" ]]; then
    return
  fi

  if [[ -f "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  if [[ -f "${PROJECT_ROOT}/${candidate}" ]]; then
    printf '%s\n' "${PROJECT_ROOT}/${candidate}"
    return
  fi

  if [[ -f "${SCRIPT_DIR}/${candidate}" ]]; then
    printf '%s\n' "${SCRIPT_DIR}/${candidate}"
    return
  fi

  if [[ -f "${SCRIPT_DIR}/../${candidate}" ]]; then
    printf '%s\n' "${SCRIPT_DIR}/../${candidate}"
    return
  fi

  printf '%s\n' "$candidate"
}

resolve_build_context_path() {
  local candidate="$1"
  if [[ -z "$candidate" ]]; then
    printf '%s\n' "$PROJECT_ROOT"
    return
  fi

  if [[ "$candidate" == /* ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  if [[ -d "${SCRIPT_DIR}/${candidate}" ]]; then
    printf '%s\n' "${SCRIPT_DIR}/${candidate}"
    return
  fi

  if [[ -d "${PROJECT_ROOT}/${candidate}" ]]; then
    printf '%s\n' "${PROJECT_ROOT}/${candidate}"
    return
  fi

  if [[ -d "${SCRIPT_DIR}/../${candidate}" ]]; then
    printf '%s\n' "${SCRIPT_DIR}/../${candidate}"
    return
  fi

  if [[ -d "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  printf '%s\n' "$candidate"
}

require_tool() {
  if [[ -n "${CONTAINER_CMD:-}" && -n "${CONTAINER_RUNTIME:-}" ]]; then
    return
  fi

  case "${CONTAINER_RUNTIME_CHOICE:-}" in
    "")
      if ! command -v docker >/dev/null 2>&1; then
        cat <<'EOF'
No supported container runtime found.

Docker was not found in PATH.
Install Docker, then rerun.
EOF
        exit 1
      fi
      CONTAINER_CMD="docker"
      CONTAINER_RUNTIME="docker"
      return
      ;;
    docker)
      if ! command -v docker >/dev/null 2>&1; then
        echo "requested CONTAINER_RUNTIME_CHOICE=docker but command not found"
        exit 1
      fi
      CONTAINER_CMD="docker"
      CONTAINER_RUNTIME="docker"
      return
      ;;
    *)
      echo "unsupported CONTAINER_RUNTIME_CHOICE=${CONTAINER_RUNTIME_CHOICE:-}"
      echo "supported value: docker"
      exit 1
      ;;
  esac
}

container_cmd() {
  local op=$1
  shift

  case "$op" in
    delete)
      "$CONTAINER_CMD" rm --force "$@"
      ;;
    list)
      "$CONTAINER_CMD" ps --all "$@"
      ;;
    *)
      "$CONTAINER_CMD" "$op" "$@"
      ;;
  esac
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INVOKE_DIR="$(pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.production"
source "${SCRIPT_DIR}/lib/signal_endpoints.sh"
cd "$PROJECT_ROOT"

COMMAND="${1:-}"
if [[ "$COMMAND" == "-h" || "$COMMAND" == "--help" ]]; then
  usage
  exit 0
fi
if [[ -z "$COMMAND" ]]; then
  usage
  exit 1
fi
shift || true

NO_BUILD=0
while (( "$#" > 0 )); do
  case "$1" in
    --env-file)
      if [[ "$#" -lt 2 || -z "$2" ]]; then
        echo "error: --env-file requires a path"
        exit 1
      fi
      ENV_FILE="$2"
      shift 2
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
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
elif [[ "$ENV_FILE" != "${SCRIPT_DIR}/.env.production" ]]; then
  echo "warning: env file not found: $ENV_FILE"
  echo "Continuing with default values."
fi

: "${SIGNAL_IMAGE:=cloud-arcade/signal:latest}"
: "${WORKER_IMAGE:=cloud-arcade/worker:latest}"
: "${PORTAL_IMAGE:=cloud-arcade/portal:latest}"

: "${SIGNAL_DOCKERFILE:=deploy/dockerfiles/signal.Dockerfile}"
: "${SIGNAL_SERVICE_DIR:=arcade-signal}"
: "${SIGNAL_SERVICE_BINARY:=signal}"
: "${SIGNAL_BUILD_CONTEXT:=$PROJECT_ROOT}"
: "${WORKER_DOCKERFILE:=deploy/dockerfiles/worker.Dockerfile}"
: "${WORKER_BUILD_CONTEXT:=arcade-worker}"
: "${WORKER_SERVICE_DIR:=.}"
: "${WORKER_SERVICE_BINARY:=worker}"
: "${WORKER_NETWORK_MODE:=}"
: "${WORKER_LOG_LEVEL:=info}"
: "${WORKER_DEFAULT_GAME:=}"
: "${WORKER_GAMES:=auto}"
: "${WORKER_GAMES_DIR:=}"
: "${WORKER_GAMES_AUTO_EXTS:=}"
: "${WORKER_GAMES_AUTO_EXCLUDE:=}"

: "${SIGNAL_ADDR:=:8000}"
: "${SIGNAL_PORT:=8000}"
: "${SIGNAL_HOST_PORT:=}"
: "${WORKER_HEALTH_ADDR:=:8081}"
: "${WORKER_HEALTH_HOST_PORT:=}"
: "${PORTAL_PORT:=8080}"

: "${REACT_APP_SIGNALING_URL:=$(arcade_default_browser_signal_path)}"
: "${WORKER_SIGNAL_URL:=}"
: "${PORTAL_SIGNAL_BACKEND:=}"

: "${SIGNAL_LOG_LEVEL:=info}"

: "${CONTAINER_PLATFORM:=linux/amd64}"
: "${CONTAINER_NETWORK:=cloud-arcade}"
: "${CONTAINER_NETWORK_SUBNET:=192.168.200.0/24}"
: "${CONTAINER_NAME_PREFIX:=}"

SIGNAL_CONTAINER_NAME="${CONTAINER_NAME_PREFIX:+${CONTAINER_NAME_PREFIX}-}signal"
WORKER_CONTAINER_NAME="${CONTAINER_NAME_PREFIX:+${CONTAINER_NAME_PREFIX}-}worker"
PORTAL_CONTAINER_NAME="${CONTAINER_NAME_PREFIX:+${CONTAINER_NAME_PREFIX}-}portal"

SIGNAL_LISTEN_PORT="${SIGNAL_ADDR#*:}"
if [[ -z "$SIGNAL_LISTEN_PORT" ]]; then
  SIGNAL_LISTEN_PORT=8000
fi

: "${SIGNAL_HOST_PORT:=${SIGNAL_PORT:-$SIGNAL_LISTEN_PORT}}"

WORKER_SIGNAL_URL="${WORKER_SIGNAL_URL:-}"
WORKER_SIGNAL_PATH="$(arcade_default_worker_signal_path)"
PORTAL_SIGNAL_BACKEND="${PORTAL_SIGNAL_BACKEND:-$SIGNAL_CONTAINER_NAME}"

worker_signal_url_for_mode() {
  local mode="${1:-}"
  mode="${mode,,}"
  case "$mode" in
    host)
      arcade_build_ws_url "127.0.0.1" "${SIGNAL_HOST_PORT}" "${WORKER_SIGNAL_PATH}"
      ;;
    ""|bridge|container|docker|network)
      arcade_build_ws_url "${SIGNAL_CONTAINER_NAME}" "${SIGNAL_LISTEN_PORT}" "${WORKER_SIGNAL_PATH}"
      ;;
    *)
      arcade_build_ws_url "${SIGNAL_CONTAINER_NAME}" "${SIGNAL_LISTEN_PORT}" "${WORKER_SIGNAL_PATH}"
      ;;
  esac
}

if [[ -z "${WORKER_SIGNAL_URL:-}" ]]; then
  WORKER_SIGNAL_URL="$(worker_signal_url_for_mode "${WORKER_NETWORK_MODE}")"
else
  local_container_url="$(arcade_build_ws_url "${SIGNAL_CONTAINER_NAME}" "${SIGNAL_LISTEN_PORT}" "${WORKER_SIGNAL_PATH}")"
  legacy_container_url="$(arcade_build_ws_url "signal" "${SIGNAL_LISTEN_PORT}" "${WORKER_SIGNAL_PATH}")"
  if [[ "${WORKER_NETWORK_MODE,,}" == "host" ]] && [[ "${WORKER_SIGNAL_URL}" == "${local_container_url}" || "${WORKER_SIGNAL_URL}" == "${legacy_container_url}" ]]; then
    WORKER_SIGNAL_URL="$(worker_signal_url_for_mode host)"
  fi
fi

WORKER_HEALTH_PORT="${WORKER_HEALTH_ADDR#*:}"
if [[ -z "$WORKER_HEALTH_PORT" ]]; then
  WORKER_HEALTH_PORT=8081
fi

: "${WORKER_HEALTH_HOST_PORT:=${WORKER_HEALTH_PORT}}"

declare -a WORKER_INSTANCE_NAMES=()
declare -a WORKER_INSTANCE_GAMES=()
declare -a WORKER_INSTANCE_HEALTH_ADDRS=()
declare -a WORKER_INSTANCE_HEALTH_PORTS=()
declare -a WORKER_INSTANCE_HEALTH_HOST_PORTS=()

trim_string() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

normalize_worker_game_path() {
  local raw="$1"
  local value
  value="$(trim_string "$raw")"
  if [[ -z "$value" ]]; then
    return 0
  fi

  if [[ "$value" == *"assets/games/"* ]]; then
    local suffix="${value##*assets/games/}"
    printf 'assets/games/%s\n' "$suffix"
    return 0
  fi

  local base="${value##*/}"
  if [[ "$base" == *.* ]]; then
    printf 'assets/games/%s\n' "$base"
    return 0
  fi

  if [[ "$value" != */* ]]; then
    printf 'assets/games/%s.zip\n' "$value"
    return 0
  fi

  printf '%s\n' "$value"
}

worker_slug_for_game() {
  local game_path="$1"
  local base="${game_path##*/}"
  base="${base%.*}"
  printf '%s\n' "$base" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//'
}

resolve_directory_path() {
  local candidate="$1"

  if [[ -z "$candidate" ]]; then
    printf '%s\n' ""
    return 0
  fi

  if [[ "$candidate" == /* ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  local base
  for base in "$INVOKE_DIR" "$PROJECT_ROOT" "$SCRIPT_DIR"; do
    if [[ -d "${base}/${candidate}" ]]; then
      printf '%s\n' "${base}/${candidate}"
      return 0
    fi
  done

  printf '%s\n' "$candidate"
}

discover_worker_games() {
  local games_dir="${WORKER_GAMES_DIR:-}"
  if [[ -z "${games_dir//[[:space:]]/}" ]]; then
    local context_root
    context_root="$(resolve_build_context_path "$WORKER_BUILD_CONTEXT")"

    local service_dir="${WORKER_SERVICE_DIR:-.}"
    service_dir="$(trim_string "$service_dir")"
    if [[ -z "$service_dir" || "$service_dir" == "." ]]; then
      games_dir="${context_root}/assets/games"
    else
      games_dir="${context_root}/${service_dir}/assets/games"
    fi
  else
    games_dir="$(resolve_directory_path "$games_dir")"
  fi

  if [[ ! -d "$games_dir" ]]; then
    return 0
  fi

  local exts="${WORKER_GAMES_AUTO_EXTS:-zip,nes,gba,gbc,gb,smc,fig,bs,cue,v64,n64,z64}"
  local exclude="${WORKER_GAMES_AUTO_EXCLUDE:-neogeo.zip}"

  local -a exclude_items=()
  if [[ -n "${exclude//[[:space:]]/}" ]]; then
    IFS=',' read -r -a exclude_items <<< "$exclude"
  fi

  local -a ext_items=()
  if [[ -n "${exts//[[:space:]]/}" ]]; then
    IFS=',' read -r -a ext_items <<< "$exts"
  fi

  local -a find_args=("$games_dir" -maxdepth 1 -type f)
  local -a pattern_args=()
  local first=1
  local ext
  for ext in "${ext_items[@]}"; do
    ext="$(trim_string "$ext")"
    [[ -z "$ext" ]] && continue
    if ((first == 0)); then
      pattern_args+=( -o )
    fi
    pattern_args+=( -iname "*.${ext}" )
    first=0
  done
  if ((${#pattern_args[@]} > 0)); then
    find_args+=( '(' "${pattern_args[@]}" ')' )
  fi

  local file
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue

    local base="${file##*/}"
    [[ -z "$base" ]] && continue
    [[ "$base" == .* ]] && continue

    local excluded=0
    local item
    for item in "${exclude_items[@]}"; do
      local trimmed
      trimmed="$(trim_string "$item")"
      [[ -z "$trimmed" ]] && continue
      if [[ "${base,,}" == "${trimmed,,}" ]]; then
        excluded=1
        break
      fi
    done
    ((excluded == 1)) && continue

    printf 'assets/games/%s\n' "$base"
  done < <(find "${find_args[@]}" -print 2>/dev/null | sort)
}

compute_worker_instances() {
  WORKER_INSTANCE_NAMES=()
  WORKER_INSTANCE_GAMES=()
  WORKER_INSTANCE_HEALTH_ADDRS=()
  WORKER_INSTANCE_HEALTH_PORTS=()
  WORKER_INSTANCE_HEALTH_HOST_PORTS=()

  local mode="${WORKER_NETWORK_MODE,,}"
  local internal_base_port="$WORKER_HEALTH_PORT"
  local host_base_port="$WORKER_HEALTH_HOST_PORT"
  if [[ "$mode" == "host" ]]; then
    host_base_port="$internal_base_port"
  fi

  local games_raw="${WORKER_GAMES:-}"
  if [[ "${games_raw,,}" == "auto" ]]; then
    local -a raw_games=()
    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      raw_games+=("$entry")
    done < <(discover_worker_games)

    local idx=0
    local raw
    for raw in "${raw_games[@]}"; do
      local normalized
      normalized="$(normalize_worker_game_path "$raw")"
      if [[ -z "$normalized" ]]; then
        continue
      fi

      local slug
      slug="$(worker_slug_for_game "$normalized")"
      if [[ -z "$slug" ]]; then
        slug="game${idx}"
      fi

      local base_name="${WORKER_CONTAINER_NAME}-${slug}"
      local unique_name="$base_name"
      local suffix=0
      while [[ " ${WORKER_INSTANCE_NAMES[*]} " == *" ${unique_name} "* ]]; do
        suffix=$((suffix + 1))
        unique_name="${base_name}-${suffix}"
      done

      local internal_port=$((internal_base_port + idx))
      local host_port=$((host_base_port + idx))

      WORKER_INSTANCE_NAMES+=("$unique_name")
      WORKER_INSTANCE_GAMES+=("$normalized")
      WORKER_INSTANCE_HEALTH_ADDRS+=(":${internal_port}")
      WORKER_INSTANCE_HEALTH_PORTS+=("${internal_port}")
      WORKER_INSTANCE_HEALTH_HOST_PORTS+=("${host_port}")

      idx=$((idx + 1))
    done
  elif [[ -n "${games_raw//[[:space:]]/}" ]]; then
    local -a raw_games=()
    IFS=',' read -r -a raw_games <<< "$games_raw"

    local idx=0
    local raw
    for raw in "${raw_games[@]}"; do
      local normalized
      normalized="$(normalize_worker_game_path "$raw")"
      if [[ -z "$normalized" ]]; then
        continue
      fi

      local slug
      slug="$(worker_slug_for_game "$normalized")"
      if [[ -z "$slug" ]]; then
        slug="game${idx}"
      fi

      local base_name="${WORKER_CONTAINER_NAME}-${slug}"
      local unique_name="$base_name"
      local suffix=0
      while [[ " ${WORKER_INSTANCE_NAMES[*]} " == *" ${unique_name} "* ]]; do
        suffix=$((suffix + 1))
        unique_name="${base_name}-${suffix}"
      done

      local internal_port=$((internal_base_port + idx))
      local host_port=$((host_base_port + idx))

      WORKER_INSTANCE_NAMES+=("$unique_name")
      WORKER_INSTANCE_GAMES+=("$normalized")
      WORKER_INSTANCE_HEALTH_ADDRS+=(":${internal_port}")
      WORKER_INSTANCE_HEALTH_PORTS+=("${internal_port}")
      WORKER_INSTANCE_HEALTH_HOST_PORTS+=("${host_port}")

      idx=$((idx + 1))
    done
  fi

  if ((${#WORKER_INSTANCE_NAMES[@]} == 0)); then
    WORKER_INSTANCE_NAMES+=("$WORKER_CONTAINER_NAME")

    local default_game=""
    if [[ -n "${WORKER_DEFAULT_GAME:-}" ]]; then
      default_game="$(normalize_worker_game_path "$WORKER_DEFAULT_GAME")"
    fi
    WORKER_INSTANCE_GAMES+=("$default_game")
    WORKER_INSTANCE_HEALTH_ADDRS+=("$WORKER_HEALTH_ADDR")
    WORKER_INSTANCE_HEALTH_PORTS+=("$WORKER_HEALTH_PORT")
    WORKER_INSTANCE_HEALTH_HOST_PORTS+=("$WORKER_HEALTH_HOST_PORT")
  fi
}

compute_worker_instances

build_signal_image() {
  local build_args=(
    --platform "$CONTAINER_PLATFORM"
    --file "$(resolve_dockerfile_path "$SIGNAL_DOCKERFILE")"
    --tag "$SIGNAL_IMAGE"
  )

  if [[ -n "$SIGNAL_SERVICE_DIR" ]]; then
    build_args+=(--build-arg SERVICE_DIR="$SIGNAL_SERVICE_DIR")
  fi

  if [[ -n "$SIGNAL_SERVICE_BINARY" ]]; then
    build_args+=(--build-arg SERVICE_BINARY="$SIGNAL_SERVICE_BINARY")
  fi

  build_args+=( "$(resolve_build_context_path "$SIGNAL_BUILD_CONTEXT")" )
  container_cmd build "${build_args[@]}"
}

build_worker_image() {
  local build_args=(
    --platform "$CONTAINER_PLATFORM"
    --file "$(resolve_dockerfile_path "$WORKER_DOCKERFILE")"
    --tag "$WORKER_IMAGE"
  )
  build_args+=(--build-arg SERVICE_DIR="$WORKER_SERVICE_DIR" --build-arg SERVICE_BINARY="$WORKER_SERVICE_BINARY")
  build_args+=( "$(resolve_build_context_path "$WORKER_BUILD_CONTEXT")" )
  container_cmd build "${build_args[@]}"
}

build_portal_image() {
  container_cmd build \
    --platform "$CONTAINER_PLATFORM" \
    --file "$(resolve_dockerfile_path "deploy/dockerfiles/portal.Dockerfile")" \
    --tag "$PORTAL_IMAGE" \
    --build-arg REACT_APP_SIGNALING_URL="$REACT_APP_SIGNALING_URL" \
    --build-arg SIGNAL_BACKEND_HOST="$PORTAL_SIGNAL_BACKEND" \
    "$PROJECT_ROOT"
}

recreate_container() {
  local name="$1"
  container_cmd stop "$name" >/dev/null 2>&1 || true
  container_cmd delete --force "$name" >/dev/null 2>&1 || true
}

create_network() {
  if container_cmd network inspect "$CONTAINER_NETWORK" >/dev/null 2>&1; then
    return 0
  fi

  container_cmd network create \
    --subnet "$CONTAINER_NETWORK_SUBNET" \
    --label "com.docker.compose.network=arcade" \
    --label "com.docker.compose.project=arcade" \
    "$CONTAINER_NETWORK" >/dev/null 2>&1
}

ensure_free_host_port() {
  local port="$1"
  local service_name="$2"
  local occupants

  if [[ -z "$port" ]]; then
    return 0
  fi

  occupants="$(container_cmd ps --filter "publish=${port}" --format '{{.Names}}' || true)"
  if [[ -z "$occupants" ]]; then
    return 0
  fi

  local allowed_container_names=(
    "$SIGNAL_CONTAINER_NAME"
    "$WORKER_CONTAINER_NAME"
    "$PORTAL_CONTAINER_NAME"
    "${WORKER_INSTANCE_NAMES[@]}"
  )
  local allow_worker_prefix=0
  if [[ "$service_name" == worker* ]]; then
    allow_worker_prefix=1
  fi

  while IFS= read -r owner; do
    [[ -z "$owner" ]] && continue

    local allowed=0
    local allowed_name
    for allowed_name in "${allowed_container_names[@]}"; do
      if [[ "$owner" == "$allowed_name" ]]; then
        allowed=1
        break
      fi
    done

    if ((allowed == 0)) && ((allow_worker_prefix == 1)); then
      if [[ "$owner" == "${WORKER_CONTAINER_NAME}-"* ]]; then
        allowed=1
      fi
    fi

    if ((allowed == 0)); then
      echo "Host port ${port} is occupied by container '${owner}' while starting ${service_name}."
      echo "Stop conflicting containers first, or override ${service_name} host port in .env file."
      exit 1
    fi
  done <<< "$occupants"
}

check_host_port_conflicts() {
  ensure_free_host_port "$SIGNAL_HOST_PORT" "signal"
  local port
  for port in "${WORKER_INSTANCE_HEALTH_HOST_PORTS[@]}"; do
    ensure_free_host_port "$port" "worker"
  done
  ensure_free_host_port "$PORTAL_PORT" "portal"
}

wait_for_url() {
  local name="$1"
  local url="$2"
  local attempts="${3:-60}"

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not installed, skipping $name health check"
    return 0
  fi

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null; then
      echo "$name is healthy"
      return 0
    fi
    sleep 1
  done
  echo "Timeout waiting for $name at $url" >&2
  return 1
}

run_ws_smoke_check_if_enabled() {
  local enabled="${RUN_WS_SMOKE_CHECK:-1}"
  local enabled_lc="${enabled,,}"
  if [[ "$enabled_lc" != "1" && "$enabled_lc" != "true" && "$enabled_lc" != "yes" ]]; then
    return 0
  fi

  local host="${WS_SMOKE_CHECK_HOST:-127.0.0.1}"
  local port="${WS_SMOKE_CHECK_PORT:-${SIGNAL_HOST_PORT:-8000}}"
  local path="${WS_SMOKE_CHECK_PATH:-/ws}"
  local timeout="${WS_SMOKE_CHECK_TIMEOUT:-8}"
  local script="${WS_SMOKE_CHECK_SCRIPT:-${SCRIPT_DIR}/ws-smoke-check.py}"

  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not installed; skipping websocket smoke check"
    return 0
  fi

  if [[ ! -f "$script" ]]; then
    echo "websocket smoke-check script not found at $script; skipping"
    return 0
  fi

  echo "Running websocket smoke check..."
  python3 "$script" --host "$host" --port "$port" --path "$path" --timeout "$timeout"
}

build_all() {
  local pids=()
  build_signal_image &
  pids+=("$!")
  build_worker_image &
  pids+=("$!")
  build_portal_image &
  pids+=("$!")

  for pid in "${pids[@]}"; do
    wait "$pid"
  done
}

start_signal() {
  container_cmd run \
    --detach \
    --rm \
    --name "$SIGNAL_CONTAINER_NAME" \
    --network "$CONTAINER_NETWORK" \
    --publish "${SIGNAL_HOST_PORT}:8000" \
    --env "SIGNAL_ADDR=$SIGNAL_ADDR" \
    --env "SIGNAL_STATIC_DIR=/app/static" \
    --env "SIGNAL_LOG_LEVEL=$SIGNAL_LOG_LEVEL" \
    "$SIGNAL_IMAGE"
}

start_worker() {
  local name="$1"
  local default_game="$2"
  local health_addr="$3"
  local health_port="$4"
  local health_host_port="$5"
  local mode="${WORKER_NETWORK_MODE,,}"

  local -a args=(
    --detach
    --rm
    --name
    "$name"
    --env
    "WORKER_SIGNAL_URL=$WORKER_SIGNAL_URL"
    --env
    "WORKER_HEALTH_ADDR=$health_addr"
    --env
    "WORKER_LOG_LEVEL=$WORKER_LOG_LEVEL"
  )

  if [[ -n "$default_game" ]]; then
    args+=(--env "WORKER_DEFAULT_GAME=$default_game")
  fi

  if [[ "$mode" == "host" ]]; then
    args+=(--network host)
  else
    args+=(--network "${CONTAINER_NETWORK}")
    if [[ -n "$health_host_port" ]]; then
      args+=(--publish "${health_host_port}:${health_port}")
    fi
  fi

  container_cmd run "${args[@]}" "$WORKER_IMAGE"
}

start_portal() {
  container_cmd run \
    --detach \
    --rm \
    --name "$PORTAL_CONTAINER_NAME" \
    --network "$CONTAINER_NETWORK" \
    --publish "${PORTAL_PORT}:80" \
    "$PORTAL_IMAGE"
}

start_stack() {
  create_network
  recreate_container "$SIGNAL_CONTAINER_NAME"
  recreate_container "$PORTAL_CONTAINER_NAME"

  start_signal
  wait_for_url "signal" "http://127.0.0.1:${SIGNAL_HOST_PORT}/healthz" 120

  recreate_container "$WORKER_CONTAINER_NAME"
  local existing_workers
  existing_workers="$(container_cmd ps --all --format '{{.Names}}' --filter "name=${WORKER_CONTAINER_NAME}-" || true)"
  if [[ -n "$existing_workers" ]]; then
    while IFS= read -r w; do
      [[ -z "$w" ]] && continue
      recreate_container "$w"
    done <<< "$existing_workers"
  fi

  local i
  for i in "${!WORKER_INSTANCE_NAMES[@]}"; do
    local worker_name="${WORKER_INSTANCE_NAMES[$i]}"
    local worker_game="${WORKER_INSTANCE_GAMES[$i]}"
    local worker_health_addr="${WORKER_INSTANCE_HEALTH_ADDRS[$i]}"
    local worker_health_port="${WORKER_INSTANCE_HEALTH_PORTS[$i]}"
    local worker_health_host_port="${WORKER_INSTANCE_HEALTH_HOST_PORTS[$i]}"

    start_worker "$worker_name" "$worker_game" "$worker_health_addr" "$worker_health_port" "$worker_health_host_port"
    wait_for_url "$worker_name" "http://127.0.0.1:${worker_health_host_port}/healthz" 120
  done

  start_portal
  wait_for_url "portal" "http://127.0.0.1:${PORTAL_PORT}/healthz" 120
  run_ws_smoke_check_if_enabled
}

stop_stack() {
  recreate_container "$SIGNAL_CONTAINER_NAME"
  recreate_container "$PORTAL_CONTAINER_NAME"

  recreate_container "$WORKER_CONTAINER_NAME"
  local existing_workers
  existing_workers="$(container_cmd ps --all --format '{{.Names}}' --filter "name=${WORKER_CONTAINER_NAME}-" || true)"
  if [[ -n "$existing_workers" ]]; then
    while IFS= read -r w; do
      [[ -z "$w" ]] && continue
      recreate_container "$w"
    done <<< "$existing_workers"
  fi
  if [[ "${CONTAINER_NAME_PREFIX}" == "" ]]; then
    recreate_container "deploy-signal-1"
    recreate_container "deploy-worker-1"
    recreate_container "deploy-portal-1"
  fi

  if container_cmd network inspect "$CONTAINER_NETWORK" >/dev/null 2>&1; then
    container_cmd network rm "$CONTAINER_NETWORK" >/dev/null 2>&1 || true
  fi
}

show_status() {
  container_cmd list --all
}

show_logs() {
  local -a targets=("$SIGNAL_CONTAINER_NAME" "$PORTAL_CONTAINER_NAME" "${WORKER_INSTANCE_NAMES[@]}")
  local include_base_worker=1
  local target
  for target in "${WORKER_INSTANCE_NAMES[@]}"; do
    if [[ "$target" == "$WORKER_CONTAINER_NAME" ]]; then
      include_base_worker=0
      break
    fi
  done
  if ((include_base_worker == 1)); then
    targets+=("$WORKER_CONTAINER_NAME")
  fi
  local -a log_pids=()

  for target in "${targets[@]}"; do
    if container_cmd inspect "$target" >/dev/null 2>&1; then
      container_cmd logs --follow "$target" &
      log_pids+=("$!")
    fi
  done

  if ((${#log_pids[@]} == 0)); then
    echo "No running stack containers found."
    return 0
  fi

  for pid in "${log_pids[@]}"; do
    wait "$pid"
  done
}

case "$COMMAND" in
  up)
    require_tool
    check_host_port_conflicts
    if (( NO_BUILD == 0 )); then
      build_all
    fi
    start_stack
    ;;
  build)
    require_tool
    build_all
    ;;
  down)
    require_tool
    stop_stack
    ;;
  restart)
    require_tool
    stop_stack
    check_host_port_conflicts
    if (( NO_BUILD == 0 )); then
      build_all
    fi
    start_stack
    ;;
  status)
    require_tool
    show_status
    ;;
  logs)
    require_tool
    show_logs
    ;;
  help)
    usage
    ;;
  *)
    echo "Unknown command: $COMMAND"
    usage
    exit 1
    ;;
esac
