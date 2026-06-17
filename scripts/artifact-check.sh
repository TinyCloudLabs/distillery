#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/scripts/artifact-feed-check.sh"
"$ROOT/scripts/artifact-backend-smoke.sh"
(cd "$ROOT" && bun test)
