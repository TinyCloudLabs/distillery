#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/artifact-lib.sh"

ensure_bun
ensure_root_deps "$ROOT"
ensure_feed_deps "$ROOT"
check_feed_submodule_drift "$ROOT"

if [ -z "${AGENT_API_TOKEN:-}" ] && [ -z "${VITE_AGENT_TOKEN:-}" ]; then
  if command -v openssl >/dev/null 2>&1; then
    token="$(openssl rand -hex 16)"
  else
    token="local-$(date +%s)"
  fi
  export AGENT_API_TOKEN="$token"
  export VITE_AGENT_TOKEN="$token"
elif [ -z "${AGENT_API_TOKEN:-}" ]; then
  export AGENT_API_TOKEN="$VITE_AGENT_TOKEN"
elif [ -z "${VITE_AGENT_TOKEN:-}" ]; then
  export VITE_AGENT_TOKEN="$AGENT_API_TOKEN"
fi

export PORTLESS_PORT="${PORTLESS_PORT:-1355}"
export VITE_AGENT_CONFIG_OVERRIDE="${VITE_AGENT_CONFIG_OVERRIDE:-1}"
export VITE_AGENT_HOST="${VITE_AGENT_HOST:-https://agent.feed.localhost:${PORTLESS_PORT}}"
export AGENT_ALLOWED_ORIGIN="${AGENT_ALLOWED_ORIGIN:-https://feed.localhost:${PORTLESS_PORT},https://feed.localhost}"
export AGENT_NAME="${AGENT_NAME:-Local Claude Distillery Agent}"

pids=()
cleanup() {
  local pid
  for pid in "${pids[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  for pid in "${pids[@]:-}"; do
    wait "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

echo "[artifact-dev-https] feed:  https://feed.localhost:${PORTLESS_PORT}"
echo "[artifact-dev-https] agent: https://agent.feed.localhost:${PORTLESS_PORT}"
echo "[artifact-dev-https] token shared through AGENT_API_TOKEN/VITE_AGENT_TOKEN"

(
  cd "$ROOT/submodules/feed"
  bun run dev
) &
pids+=("$!")

(
  cd "$ROOT"
  bun run artifact:agent:dev:https
) &
pids+=("$!")

while :; do
  for pid in "${pids[@]}"; do
    if ! ps -p "$pid" >/dev/null 2>&1; then
      wait "$pid"
      exit $?
    fi
  done
  sleep 1
done
