#!/usr/bin/env bash

set -euo pipefail

arcade_resolve_env_file_path() {
  local candidate="${1:-}"
  shift || true

  if [[ -z "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  if [[ "$candidate" == /* ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  local base
  for base in "$@"; do
    if [[ -f "${base}/${candidate}" ]]; then
      printf '%s\n' "${base}/${candidate}"
      return
    fi
  done

  printf '%s\n' "$candidate"
}

arcade_load_env_file() {
  local env_file="${1:-}"
  local default_file="${2:-}"

  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    return
  fi

  if [[ -n "$env_file" && -n "$default_file" && "$env_file" != "$default_file" ]]; then
    echo "warning: env file not found: $env_file"
    echo "Continuing with default values."
  fi
}

