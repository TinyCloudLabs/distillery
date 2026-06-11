#!/bin/bash
# feedrun.sh — the launchd feed-run wrapper (spec §7a) AND the Generate button's
# spawn target (spec §8). One code path for cron + button.
#
# launchd hands a process a MINIMAL environment (no login PATH, no shell rc).
# This wrapper is the bridge: it rebuilds PATH so `claude` + `bun` resolve, it
# exports TRANSCRIPT_DIRS so index-corpus can find the corpus, it sources the
# repo .env for the Gemini key (TTS + image steps need it; index/query/distill
# don't), then runs the feed-run recipe.
#
# TWO MODES:
#   full (default)  invoke the recipe HEADLESSLY via `claude -p` (the
#                   reference_claude_cli_headless recipe — --system-prompt fully
#                   overrides the default so the run is clean, no SessionStart
#                   chatter). The agent reads SKILL.md and does the judgment.
#   dry-run         run the orchestrator directly (feed-run.ts --no-generate):
#                   produces the brief + advances the cursor, NO model calls, NO
#                   media spend, NO publish. The Generate button's safe preview.
#                   Selected by FEEDRUN_DRY_RUN=1.
#
# Concurrency (spec §10 R1): a PID lockfile at index/.run.lock. A second run
# (overlapping cron, or button-while-cron) aborts early with exit 75
# (EX_TEMPFAIL) — POST /api/generate maps that to a 409.
#
# Failures are LOUD (set -e + explicit guards) so the log shows exactly which
# prerequisite was missing (R5: PATH / key drift).

set -euo pipefail

# --- resolve the repo root (this script lives at $REPO/ops/launchd/) ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO"

DRY_RUN="${FEEDRUN_DRY_RUN:-0}"

# --- environment: PATH + per-deploy config ------------------------------------
# feedrun.env is gitignored (machine-specific tool paths + the TRANSCRIPT_DIRS
# allowlist). It MUST export at least:
#   PATH            — including the dirs holding `claude` and `bun`
#   TRANSCRIPT_DIRS — comma-separated absolute corpus dirs (index-corpus reads it)
# and MAY export FEEDRUN_MODE, FEEDRUN_MODEL, FEEDRUN_SINCE.
ENV_FILE="$SCRIPT_DIR/feedrun.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
else
  echo "[feedrun] FATAL: $ENV_FILE not found — copy feedrun.env.example and fill it in." >&2
  exit 78  # EX_CONFIG
fi

# Source the repo .env for the Gemini key (the only metered cost; TTS + images).
# Never committed (.env gitignored). A dry-run never spends, so the key is
# irrelevant there.
if [[ -f "$REPO/.env" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$REPO/.env"; set +a
fi

# --- prerequisite checks (R5: fail loud, not silently) ------------------------
command -v bun >/dev/null 2>&1 || { echo "[feedrun] FATAL: 'bun' not on PATH ($PATH)" >&2; exit 78; }
if [[ "$DRY_RUN" != "1" ]]; then
  command -v claude >/dev/null 2>&1 || { echo "[feedrun] FATAL: 'claude' not on PATH ($PATH)" >&2; exit 78; }
  if [[ -z "${TRANSCRIPT_DIRS:-}" ]]; then
    echo "[feedrun] FATAL: TRANSCRIPT_DIRS unset (set it in $ENV_FILE)" >&2
    exit 78
  fi
  if [[ -z "${GOOGLE_AI_API_KEY:-}${GEMINI_API_KEY:-}${GOOGLE_API_KEY:-}" ]]; then
    echo "[feedrun] WARN: no Gemini key in .env — TTS + image steps will fail; text artifacts still generate." >&2
  fi
fi

# --- concurrency lock (spec §10 R1) -------------------------------------------
LOCK="$REPO/index/.run.lock"
mkdir -p "$REPO/index"
if [[ -f "$LOCK" ]]; then
  LOCK_PID="$(head -n1 "$LOCK" 2>/dev/null || true)"
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "[feedrun] a run is already in progress (pid $LOCK_PID, lock $LOCK) — aborting." >&2
    exit 75  # EX_TEMPFAIL → the Generate route maps this to HTTP 409
  fi
  echo "[feedrun] stale lock for dead pid $LOCK_PID — reclaiming." >&2
fi
printf '%s\n%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

# --- the run ------------------------------------------------------------------
MODE="${FEEDRUN_MODE:-daily}"
MODEL="${FEEDRUN_MODEL:-opus}"
SINCE_NOTE=""
[[ -n "${FEEDRUN_SINCE:-}" ]] && SINCE_NOTE="Use --since ${FEEDRUN_SINCE}. "

echo "[feedrun] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting mode=$MODE model=$MODEL dry_run=$DRY_RUN repo=$REPO" >&2

# The Generate button picks a run id so its status endpoint can find
# index/runs/<run-id>/ before the run finishes. Thread it through both paths.
RUN_ID_ARG=()
if [[ -n "${FEEDRUN_RUN_ID:-}" ]]; then
  RUN_ID_ARG=(--run-id "$FEEDRUN_RUN_ID")
fi

if [[ "$DRY_RUN" == "1" ]]; then
  # Direct orchestrator run: brief + cursor only, no model calls, no publish.
  # --skip-index lets the preview run off the existing index without re-walking
  # the corpus (and without needing TRANSCRIPT_DIRS).
  bun skills/feed-run/scripts/feed-run.ts \
    --mode "$MODE" --no-generate --skip-index \
    "${RUN_ID_ARG[@]}" \
    ${FEEDRUN_SINCE:+--since "$FEEDRUN_SINCE"}
else
  # Full headless run. The system prompt fully overrides the default (clean
  # run); the user message points the agent at SKILL.md. The orchestrator
  # (feed-run.ts) is the deterministic spine the agent drives.
  SYSTEM_PROMPT="You are the distillery feed-run agent, invoked headlessly. Execute skills/feed-run/SKILL.md exactly. Judgment is yours; the orchestrator does the deterministic plumbing (index, distill, query, brief). Run the artifact skills with the MANDATORY adversarial novelty critic, respect MAX_ARTIFACTS_PER_RUN, publish survivors to artifacts/, and append the surfaced ledger. Quality beats quantity — zero artifacts is a valid run."
  if [[ -f "$SCRIPT_DIR/feedrun.system.md" ]]; then
    SYSTEM_PROMPT="$(cat "$SCRIPT_DIR/feedrun.system.md")"
  fi
  claude -p \
    "Run the distillery feed-run recipe (${MODE} mode). ${SINCE_NOTE}Read skills/feed-run/SKILL.md and execute its ordered pipeline end to end." \
    --system-prompt "$SYSTEM_PROMPT" \
    --model "$MODEL"
fi

echo "[feedrun] $(date -u +%Y-%m-%dT%H:%M:%SZ) done." >&2
