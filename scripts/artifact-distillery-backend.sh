#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/artifact-lib.sh"

ensure_bun
ensure_root_deps "$ROOT"

export DISTILLERY_REPO_ROOT="${DISTILLERY_REPO_ROOT:-$ROOT}"
export AGENT_ALLOWED_ORIGIN="${AGENT_ALLOWED_ORIGIN:-http://localhost:5173}"

cd "$ROOT"
exec bun harness/agent/src/server.ts "$@"
