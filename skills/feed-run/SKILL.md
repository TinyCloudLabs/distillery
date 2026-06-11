# Skill: feed-run

The **saved orchestration recipe** (spec §5) — the runbook that turns the
one-shot generation skills into an autonomous heartbeat. It sequences the
deterministic corpus-navigation skills (`index-corpus`, `distill-preferences`,
`query-corpus`) into a run-brief, then hands that brief to the existing
generation skills, which do the judgment.

This skill is **both a runnable orchestrator and a runbook**:

- `scripts/feed-run.ts` is a bun orchestrator that shells the Layer-1 skill
  scripts in order and PREPARES a **run-brief**. It is what the future launchd
  cron (spec §7) and the Generate button (spec §8) invoke. **It makes NO model
  calls** — judgment-vs-plumbing is preserved exactly: the orchestrator is
  plumbing; generation is your judgment.
- This SKILL.md is the runbook **you** (the agent) follow to do the part the
  orchestrator can't: read the selected transcripts, generate artifacts, run
  the critics, publish survivors, and write the ledger back.

Any agent that can run bun can run the recipe (Claude Code, Hermes, Codex). The
recipe is just a prompt + scripts — nothing couples it to one agent.

## Prerequisites

- bun installed.
- `$TRANSCRIPT_DIRS` exported (comma-separated absolute dirs) so `index-corpus`
  can find the corpus. Nothing is hardcoded — same rule as the base SPEC. (Not
  required with `--skip-index`, which reuses the already-built index — handy for
  a `--dry-run` / Generate-button run that just wants a brief off the last index.)
- `GEMINI_API_KEY` / `GOOGLE_AI_API_KEY` only for the generation media steps
  (TTS + images); index/query/distill/brief need no key.

## The ordered pipeline (spec §5)

Run from the distillery repo root. The orchestrator runs steps 1–4 (plumbing)
and stops at the brief; you do steps 5–6 (judgment), then write the ledger.

```sh
bun skills/feed-run/scripts/feed-run.ts \
  [--mode daily|backfill]      # daily heartbeat (default) | one-time excavation (stub)
  [--since 14d|2026-06-01]     # recency lower bound (relative or absolute);
                               #   default = last run from ledger, else 7 days
  [--dry-run]                  # stop after the brief (no generation) — the safe default for a first look
  [--skip-index]               # reuse the existing index (no re-index, no $TRANSCRIPT_DIRS needed)
  [--index-path index/corpus-index.json] [--ledger index/surfaced.json]
  [--artifacts-dir artifacts] [--preferences PREFERENCES.md]
  [--runs-dir index/runs] [--run-log index/run-log.jsonl] [--recency-limit N]
```

| step | what runs | who |
|---|---|---|
| 1. INDEX | `index-corpus --prune` (fresh, incremental index) | orchestrator |
| 2. DISTILL | `distill-preferences` aggregation, BEFORE generation ([D4]) | orchestrator (aggregation) + you (PREFERENCES.md edits) |
| 3a. QUERY recency | `query-corpus --since <since> --unsurfaced-only` | orchestrator |
| 3b. QUERY deep-dive | one high-novelty, never-surfaced older thread past the cursor (ranked by the novelty proxy); advance **and persist** the cursor | orchestrator |
| 4. BRIEF | render `run-brief.md` (titles + paths + preferences + baseline + cap) | orchestrator |
| 5. GENERATE + CRITIC | run the generation skills against the brief, each with its own novelty-scan + adversarial critic | **you** |
| 6. SAVE / PUBLISH | `save.ts` writes survivors to `artifacts/`; append surfaced ENTRIES to `surfaced.json` (the cursor is already persisted by step 3b) | **you** |

The orchestrator writes a per-run dir `index/runs/<ts>/` containing
`run-brief.md` + `run-log.json`, and appends a one-liner to
`index/run-log.jsonl` (spec §7 — the Generate button polls this). The brief is
also printed to **stdout** so you can consume it directly.

## What the orchestrator surfaces (and what it never does)

The brief lists, for the recency window + the one deep-dive pick: **title,
date, path, source, and the index's short match-context snippets** — never
transcript bodies. It also embeds the current `PREFERENCES.md` (last-known-good)
and a prior-artifact baseline summary. **It never calls an LLM and never
publishes.** `--dry-run` makes the stop-at-brief explicit; a non-dry run still
stops at the brief because generation is your job — the difference is only what
the run-log records.

## Steps 5–6 — your judgment (after the brief)

1. **Read the actual transcripts** at the paths in the brief (the orchestrator
   only surfaced paths). The recency set is "what's new"; the deep-dive is one
   older thread the cursor rotated to.
2. **Generate** with the existing skills — `extract-insights`,
   `write-article`, `make-podcast`, `illustrate-card` — each running its own
   `novelty-scan` + the **mandatory adversarial-novelty critic** baked into
   those skills. Honor the cap in the brief (`MAX_ARTIFACTS_PER_RUN`, default 3;
   backfill 25): publish the **best ≤ cap**. **Zero artifacts is a valid run.**
3. **Publish** survivors with `save.ts` (auto-publish straight to `artifacts/`,
   [D3] — the feed reads it live). One hero image per artifact (`MAX_ILLUSTRATE`
   = artifacts published).
4. **Write the surfaced ENTRIES back** so the deep-dive / backfill don't
   re-chew these threads. For every transcript you EXAMINED (shipped or not),
   append a `surfaced.json` entry. **You do NOT touch the deep-dive cursor** —
   the orchestrator already advanced AND PERSISTED it (its `save` step writes
   `surfaced.json` with the cursor moved onto the picked thread; see the
   run-log). Re-read the ledger before appending so you build on the
   orchestrator's persisted cursor instead of clobbering it. Use the helpers:

   ```ts
   import { readLedger, writeLedger, appendSurfaced }
     from "skills/query-corpus/scripts/surfaced-ledger.ts";
   import { topicKeysFor, ledgerMode }
     from "skills/feed-run/scripts/feed-run-lib.ts";
   // Re-read so we keep the orchestrator's already-advanced cursor:
   let ledger = await readLedger("index/surfaced.json");
   // for each examined record `rec` with outcome "shipped" | "examined-no-ship":
   ledger = appendSurfaced(ledger, {
     path: rec.path,
     topic_keys: topicKeysFor(rec),
     run_id: runIdFromBrief,
     outcome,
     mode: ledgerMode("daily", isDeepDive ? "deepdive" : "recency"),
     content_hash: rec.content_hash,  // R3: re-eligibility on later edits
   });
   // Append ENTRIES ONLY — never reconstruct deepdive_cursor (the orchestrator
   // owns it; reconstructing from deepDivePath risks clobbering it with undefined).
   await writeLedger("index/surfaced.json", ledger);
   ```

## Deep-dive cursor (spec §5)

The orchestrator builds the candidate set with `query-corpus --unsurfaced-only`
over **all-but-recent** transcripts, then **ranks it by the index-only novelty
proxy** (single-voice **entity count** + **drift-group membership** — quantity
values recurring across 2+ transcripts — both computed from the index, no
transcript re-reads). **That novelty rank IS the cursor order**: novelty is the
primary sort key, with date-desc then path as the deterministic tiebreak. The
cursor walks the novelty order, so the deep-dive surfaces high-novelty old
threads first rather than merely the oldest. It advances exactly one transcript
per run and **wraps** at the end. Wrapping never re-surfaces, because the
candidate list is already `--unsurfaced-only` — a thread surfaced on a prior lap
drops out.

The orchestrator **persists the advanced cursor itself** (its `save` step writes
`surfaced.json` with `deepdive_cursor.last_path` moved onto the picked thread),
EXCEPT under `--dry-run` (which reports the would-be advance but never mutates
state). This guarantees the cursor moves even on a **zero-artifact run** — the
same thread is never re-picked forever just because nothing shipped. The agent
appends only surfaced ENTRIES afterward and must NOT reconstruct the cursor.

## Per-step failure degradation (spec §5)

The run never hard-fails on a single step:

| step fails | behavior |
|---|---|
| INDEX | **abort** the run + log; the feed is unchanged, the server keeps serving the last artifacts |
| DISTILL | proceed with the **existing PREFERENCES.md** (last-known-good); log a warning; the brief notes it's degraded |
| QUERY recency | empty window → **deep-dive-only** run (not an error) |
| QUERY deep-dive | no eligible older thread (all surfaced) → **recency-only** run |
| GENERATE/CRITIC | a single skill failure drops that candidate, not the run; **zero artifacts is valid** |
| SAVE | per-artifact: a failed save drops that artifact. The deep-dive cursor is persisted by the orchestrator the moment a candidate is picked (step 3b), independent of whether anything ships — so a zero-artifact run still rotates the cursor |

Every step outcome (`ok` / `skipped` / `degraded` / `failed` / `aborted`)
appends to the structured run-log so a failed/empty run is inspectable.

## Backfill mode (spec §6) — STUB in this PR

`--mode backfill` is **wired but stubbed**: it sets the larger cap
(`MAX_ARTIFACTS_BACKFILL = 25`) and surfaces it in the brief, then runs the
daily selection path underneath. The full one-time excavation — no recency
window, novelty-ranked batches with a resumable checkpoint, coverage recording
with `mode: "backfill"` — is **deferred to PR6** (noted as a TODO in the code).

## Parameters (spec §5)

| param | flag / source | default | meaning |
|---|---|---|---|
| RECENCY_SINCE | `--since` | last run from ledger, else 7 days | recency lower bound (relative `14d`/`3w` or absolute date) |
| DEEPDIVE_PER_RUN | (fixed) | 1 | older threads excavated per run ([D2]) |
| MAX_ARTIFACTS_PER_RUN | mode | 3 (daily) / 25 (backfill) | cost guardrail; surfaced in the brief |
| MAX_ILLUSTRATE | derived | = artifacts published | one hero image per artifact |
| (reuse index) | `--skip-index` | off | reuse the existing index instead of re-indexing; lets `--dry-run` / the Generate button run without `$TRANSCRIPT_DIRS` |

## Consumers

- **launchd cron** (spec §7, PR5): `ops/feed-run.sh` invokes `claude -p` against
  this SKILL.md; the orchestrator is the deterministic spine.
- **Generate button** (spec §8, PR7): `POST /api/generate` spawns the same
  wrapper; the UI polls `index/run-log.jsonl` for progress. A dry-run preview
  can pass `--skip-index --dry-run` to produce a brief off the existing index
  without `$TRANSCRIPT_DIRS`.
- **Hermes / other agents** (spec R4): can run the orchestrator + this runbook
  directly — agent-agnostic by construction.
