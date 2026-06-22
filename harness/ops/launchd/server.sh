#!/bin/bash
# server.sh — LEGACY keep-alive Folio feed-server wrapper (spec §7b).
#
# launchd's minimal env can't find bun and doesn't know the OpenKey allowlist.
# This wrapper sources server.env (PATH + OPENKEY_ALLOWED_ADDRESSES +
# TRANSCRIPT_DIRS so the Generate button's spawned run inherits them), builds the
# SPA, then execs `bun src/server.ts`. KeepAlive in the plist restarts it on
# crash; exec means the bun process IS the launchd job (signals + restart work).
#
# Current Artifactory/Feed development uses submodules/feed plus harness/agent
# via `bun run artifact:dev:https`. Keep this wrapper only for old local
# installs until they are migrated.

set -euo pipefail

# This script lives at $REPO/harness/ops/launchd/, so the repo root is 3 up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"

ENV_FILE="$SCRIPT_DIR/server.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
else
  echo "[server] FATAL: $ENV_FILE not found — copy server.env.example and fill it in." >&2
  exit 78
fi

# The repo .env carries the Gemini key the Generate button's spawned run needs.
if [[ -f "$REPO/.env" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$REPO/.env"; set +a
fi

command -v bun >/dev/null 2>&1 || { echo "[server] FATAL: 'bun' not on PATH ($PATH)" >&2; exit 78; }

cd "$REPO/harness/feed"
# Build the SPA so web/dist exists (the server 404s the shell without it).
echo "[server] $(date -u +%Y-%m-%dT%H:%M:%SZ) building web/dist…" >&2
bun run build

echo "[server] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting feed server on port ${PORT:-4242}…" >&2
exec bun src/server.ts
