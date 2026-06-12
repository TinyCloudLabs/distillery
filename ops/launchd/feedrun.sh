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

# --- command-line args (FIX C) ------------------------------------------------
# Honor `--dry-run` as a CLI ARG, not just the FEEDRUN_DRY_RUN env. Previously the
# wrapper read ONLY the env and SILENTLY IGNORED any positional arg — so a manual
# `feedrun.sh --dry-run` (the obvious way to ask for a no-spend preview) ran a
# REAL generation (Gemini money + live publish). Now the arg maps to the dry path
# (env and arg are OR'd: either selects dry), and any UNKNOWN arg fails LOUD so a
# typo can never silently fall through to a real run.
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      echo "usage: feedrun.sh [--dry-run]   (or set FEEDRUN_DRY_RUN=1)" >&2
      echo "  --dry-run   brief + cursor only; NO model calls, NO spend, NO publish." >&2
      exit 0 ;;
    *)
      echo "[feedrun] FATAL: unknown argument '$arg' (accepted: --dry-run, --help)." >&2
      echo "[feedrun] refusing to run rather than silently ignore it — a typo must not trigger a real generation." >&2
      exit 64  # EX_USAGE
      ;;
  esac
done

# --- lock paths + deterministic release (FIX B) -------------------------------
# Define the lock paths up front so the release trap can be armed EARLY. The
# route's TS lock and the wrapper's atomic lockdir:
LOCK="$REPO/index/.run.lock"          # the route's TS lock uses this exact path (a file)
LOCK_DIR="$REPO/index/.run.lock.d"    # the wrapper's atomic lockdir
# Tracks whether WE won the atomic lockdir (so the trap knows what to release).
OWN_LOCK=0
# Tracks whether the route handed us the file lock ($LOCK) to release. The route
# (Generate button) ALWAYS sets FEEDRUN_RUN_ID and pre-stamps $LOCK with the
# SERVER pid before spawning us; cron never sets it. Without this, a wrapper that
# exits EARLY (e.g. a prereq `exit 78` BEFORE it wins the atomic lockdir) would
# leave the route's $LOCK held by the live server pid FOREVER — never reclaimable
# by stale-pid logic (the server is alive), wedging every future run. So a
# route-spawned wrapper owns $LOCK from birth and must release it on ANY exit.
RELEASE_FILE_LOCK=0
[[ -n "${FEEDRUN_RUN_ID:-}" ]] && RELEASE_FILE_LOCK=1

# release_locks — the single cleanup, idempotent + best-effort. Removes the
# atomic lockdir only if WE won it (never steal a competitor's), and the route's
# file lock only if it was handed to us. Armed for EXIT/INT/TERM the moment we
# know what we own, so completion (success OR failure, including early prereq
# exits) ALWAYS releases — never relies on stale-pid reclaim.
release_locks() {
  [[ "$OWN_LOCK" == "1" ]] && rm -rf "$LOCK_DIR"
  [[ "$RELEASE_FILE_LOCK" == "1" ]] && rm -f "$LOCK"
  return 0  # never let the trap's last [[ ]] flip the script's real exit code
}
# Arm immediately: a route-spawned wrapper that dies in the prereq checks below
# (before the atomic acquire) still releases the route's $LOCK. OWN_LOCK is still
# 0 here, so this early arm never touches the atomic lockdir we haven't won.
trap release_locks EXIT INT TERM

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
# ATOMIC acquire (review High #2): the old `[[ -f $LOCK ]]` … `printf > $LOCK`
# was check-then-write — two wrappers (button + cron, or two clicks) could both
# pass the `-f` test before either wrote, and both run → double Gemini spend.
# `mkdir` is atomic (a single syscall that fails if the dir exists), so exactly
# one wrapper wins the create. The pid file inside the lockdir carries the owner
# for stale detection. ($LOCK / $LOCK_DIR and the release trap are defined up top
# so an early prereq exit still releases — FIX B.)
mkdir -p "$REPO/index"

# Stamp OUR ownership into the freshly-won lockdir. Called the instant after a
# winning `mkdir`, so the pid file exists before any competitor inspects it (no
# empty-pid window that a racer could mis-read as stale).
stamp_lock() {
  printf '%s\n%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_DIR/pid"
  printf '%s\n%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK"
}

acquire_lock() {
  # Try the atomic create. On success WE own the lock — stamp it immediately.
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    stamp_lock
    return 0
  fi
  # Lock exists. Is the holder alive? A live holder (or a winner mid-stamp whose
  # pid file we can't read yet) means we LOSE — never reclaim a lock we cannot
  # prove is stale. Only a readable, dead pid is reclaimable.
  local owner
  owner="$(head -n1 "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -z "$owner" ]]; then
    return 1  # can't prove staleness → treat as held (avoid stealing a live lock)
  fi
  if kill -0 "$owner" 2>/dev/null; then
    return 1  # live holder — we lose
  fi
  echo "[feedrun] stale lock for dead pid $owner — reclaiming." >&2
  rm -rf "$LOCK_DIR"
  # Retry the atomic create exactly once; a concurrent reclaimer may beat us.
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    stamp_lock
    return 0
  fi
  return 1
}

if ! acquire_lock; then
  LOCK_PID="$(head -n1 "$LOCK_DIR/pid" 2>/dev/null || true)"
  echo "[feedrun] a run is already in progress (pid ${LOCK_PID:-?}, lock $LOCK_DIR) — aborting." >&2
  # We LOST the race: another wrapper owns BOTH the lockdir and $LOCK. Disarm our
  # file-lock release so this loser never deletes the WINNER's $LOCK on exit.
  # (OWN_LOCK is still 0, so the lockdir is already safe from us.)
  RELEASE_FILE_LOCK=0
  exit 75  # EX_TEMPFAIL → the Generate route maps this to HTTP 409
fi
# We won + stamped the lock. Mark ownership so the EARLY-armed release trap now
# also tears down the atomic lockdir. The route's file lock ($LOCK) — overwritten
# by stamp_lock with OUR pid — is released by the same trap on ANY exit
# (success/failure/signal). Completion deterministically releases; no run ever
# relies on stale-pid reclaim.
OWN_LOCK=1
RELEASE_FILE_LOCK=1

# TEST SEAM: with FEEDRUN_LOCK_HOLD=<seconds> the wrapper acquires the lock, holds
# it for that long, then exits WITHOUT running generation (no claude/bun spend).
# Lets the lock-atomicity regression test drive the REAL acquire path. Never set
# in prod (cron/button leave it unset).
if [[ -n "${FEEDRUN_LOCK_HOLD:-}" ]]; then
  echo "[feedrun] TEST: lock held by pid $$ for ${FEEDRUN_LOCK_HOLD}s, then exit." >&2
  sleep "$FEEDRUN_LOCK_HOLD"
  exit 0
fi

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
  SYSTEM_PROMPT="You are the distillery feed-run agent, invoked headlessly. Execute skills/feed-run/SKILL.md exactly. Judgment is yours; the orchestrator does the deterministic plumbing (index, distill aggregation, query, brief). FIRST, before generating anything, close the preference loop per skills/distill-preferences/SKILL.md: read the brief's embedded feedback summary + the reacted-to artifacts and update ONLY the [learned] bullets in PREFERENCES.md (never touch human-authored lines; >=2 consistent signals before a generalization; cite evidence counts), then re-read PREFERENCES.md. THEN run the artifact skills with the MANDATORY adversarial novelty critic, respect MAX_ARTIFACTS_PER_RUN, publish survivors to artifacts/, and append the surfaced ledger. Quality beats quantity — zero artifacts is a valid run."
  if [[ -f "$SCRIPT_DIR/feedrun.system.md" ]]; then
    SYSTEM_PROMPT="$(cat "$SCRIPT_DIR/feedrun.system.md")"
  fi
  claude -p \
    "Run the distillery feed-run recipe (${MODE} mode). ${SINCE_NOTE}Read skills/feed-run/SKILL.md and execute its ordered pipeline end to end." \
    --system-prompt "$SYSTEM_PROMPT" \
    --model "$MODEL"
fi

echo "[feedrun] $(date -u +%Y-%m-%dT%H:%M:%SZ) done." >&2
