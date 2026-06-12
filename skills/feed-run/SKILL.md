# Skill: feed-run

The **saved orchestration recipe** (spec §5) — the runbook that turns the
one-shot generation skills into an autonomous heartbeat. It sequences the
deterministic corpus-navigation skills (`index-corpus`, `distill-preferences`,
`query-corpus`) into a run-brief, then hands that brief to the existing
generation skills, which do the judgment.

This skill is **both a runnable orchestrator and a runbook**:

- `scripts/feed-run.ts` is a bun orchestrator that shells the Layer-1 skill
  scripts in order and PREPARES a **run-brief**. It is what the future launchd
  cron (spec §7) and the Generate button (spec §8) invoke. **The orchestrator's
  index / query / brief plumbing makes NO model calls** — judgment-vs-plumbing
  is preserved exactly. WITHOUT `--dry-run`/`--no-generate`, the orchestrator
  then invokes a generation AGENT **headlessly** (`scripts/run-generation.ts`
  shells `claude -p`, the reference_claude_cli_headless recipe) to consume the
  brief and produce artifacts — that's the ORCHESTRATION layer, explicitly
  allowed to invoke the agent CLI. The headless agent runs the same judgment
  this SKILL.md describes.
- This SKILL.md is the runbook the generation agent follows: read the selected
  transcripts, generate artifacts, run the critics, publish survivors, and write
  the ledger back. The headless runner passes it to `claude -p` as a system
  prompt; a human agent can also follow it directly.

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
  [--dry-run]                  # stop after the brief (no generation, no state mutation) — the safe default for a first look
  [--no-generate]              # produce the brief + persist the cursor, but skip headless generation (the Generate button's dry preview)
  [--model opus]               # generation model for the headless agent (else $MEET_GEN_MODEL, else opus)
  [--skip-index]               # reuse the existing index (no re-index, no $TRANSCRIPT_DIRS needed)
  [--index-path index/corpus-index.json] [--ledger index/surfaced.json]
  [--artifacts-dir artifacts] [--preferences PREFERENCES.md]
  [--runs-dir index/runs] [--run-log index/run-log.jsonl] [--recency-limit N]
```

| step | what runs | who |
|---|---|---|
| 1. INDEX | `index-corpus --prune` (fresh, incremental index) | orchestrator |
| 2. DISTILL (aggregate) | `distill-preferences` aggregation (`summarize-events.ts`), BEFORE generation ([D4]); its output is **embedded in the brief** | orchestrator (aggregation only — NO model calls) |
| 3a. QUERY recency | `query-corpus --since <since> --unsurfaced-only`, then **preference-WEIGHTED re-rank** (selection backpressure — `rankRecencyByPreference` over the `[learned]` signal) | orchestrator (deterministic, no model calls) |
| 3b. QUERY deep-dive | one high-novelty, never-surfaced older thread past the cursor (ranked by the novelty proxy); advance **and persist** the cursor. **Preference-AGNOSTIC by design** — the exploration reserve | orchestrator |
| 4. BRIEF | render `run-brief.md` (feedback summary + titles + paths + preferences + baseline + cap) | orchestrator |
| 5a. DISTILL (judge + write) | apply distill-preferences judgment over the embedded feedback summary → update **only `[learned]` lines** in `PREFERENCES.md` → re-read it | **headless agent — FIRST task, before any generation** |
| 5b. GENERATE + CRITIC | run the generation skills against the brief + the **freshly-updated** PREFERENCES.md, each with its own novelty-scan + adversarial critic. **PREFERENCES.md STEERS topic/format/depth** (generation backpressure — mandatory, see below) | **headless agent** (orchestrator spawns it via `run-generation.ts` → `claude -p`; `--dry-run`/`--no-generate` skip this) |
| GUARD (finding A) | DETERMINISTIC human-line guard around the agent's distill write: snapshot non-`[learned]` lines before, assert unchanged after, **restore + loud error** on any human-line edit/removal/reorder | **orchestrator** (`guard-preferences.ts`; no model calls) |
| VERIFY (finding B) | DETERMINISTIC post-run check that the distill happened: pending feedback events must have produced a `[learned]` change OR an explicit "no change warranted" log, else **`distill_skipped=true`** in the run-log (never a silent pass) | **orchestrator** (`verify-distill.ts`; no model calls) |
| 6. SAVE / PUBLISH | `save.ts` writes survivors to `artifacts/`; append surfaced ENTRIES to `surfaced.json` (the cursor is already persisted by step 3b) | **headless agent** |

**The loop is ENFORCED, not instruction-only (PR #8 review).** The mandate in
5a used to be convention. Two deterministic guards now make it unbreakable:
the **human-line guard** (`guard-preferences.ts`) brackets the agent's distill —
it snapshots every non-`[learned]` line, and if the agent edited/removed/added/
reordered any of them it RESTORES `PREFERENCES.md` from the snapshot and logs a
loud error (only `- [learned]` bullets may change). The **distill verification**
(`verify-distill.ts`) tracks a cursor (`index/distill-cursor.json`: newest event
ts + `[learned]` fingerprint at the last distill) and, if there are new feedback
events but the agent changed no `[learned]` line and logged no "no change
warranted" decision, flags `distill_skipped=true` in the run-log. Both run
post-distill, pre-`save`; both make NO model calls.

**Why the distill is split across two steps (the loop-closing wire).** The
deterministic half (step 2, `summarize-events.ts`) only *aggregates* the
feedback log — it can never decide what the aggregates MEAN, so it can never
write a `[learned]` line. The judgment half (step 5a) is where reactions become
preferences, and it is **agent work** (distillation is judgment → best model).
For a long time only step 2 ran and nothing ever wrote `[learned]` lines, so
the feed never learned. The wire: the orchestrator embeds the step-2 aggregation
in the brief, and the generation agent runs the distill-preferences judgment as
its **mandatory first task** — update `[learned]` lines, re-read `PREFERENCES.md`,
THEN generate against the fresh file. This is not skippable: it happens every
run (even a zero-update run is valid), so feedback always feeds forward before
the next batch is generated.

## Backpressure — PREFERENCES.md is a CONTROL VALVE on BOTH ends

PREFERENCES.md is not a passive journal of what Hunter reacted to. It is
**backpressure**: a control valve that steers BOTH what the engine SELECTS from
the corpus AND what it GENERATES, shaping the feed toward Hunter over time.
Backpressure operates at two points:

**A. SELECTION backpressure (upstream — DETERMINISTIC, model-free).** The
orchestrator re-ranks the **recency pool** (step 3a) by the `[learned]` signal:
`parsePreferenceSignal` parses PREFERENCES.md's `[learned]` Topics/Style/Formats
bullets into loved keywords and the Novelty-bar / `less` / `already_knew`
bullets into disliked keywords (with per-keyword weights; a keyword that is both
is dropped — neutral). `scorePreferenceMatch` then scores each recency candidate
over the index record's title/entities/terms (no transcript re-read), and
`rankRecencyByPreference` floats preference-matching transcripts up and disliked
ones down. The weighting is **transparent** — every candidate's loved/disliked
keyword hits are logged to stderr (`recency rank: <title> — score …`). All of
this is in `skills/query-corpus/scripts/preference-signal.ts` +
`feed-run-lib.ts`; it makes **no model calls**.

**The anti-filter-bubble split (deliberate, load-bearing).** Only the RECENCY
pool is preference-weighted. The **rotating deep-dive cursor stays
preference-AGNOSTIC** (`rankDeepDiveCandidates` has no preference parameter at
all) — it is the DISCOVERY channel for asymmetric knowledge Hunter doesn't yet
know he wants. Weighting both would collapse the feed into an echo chamber, so
the exploration reserve is enforced by construction: the signal is wired into
the recency ranker and **never** into the deep-dive ranker.

**B. GENERATION backpressure (downstream — AGENT judgment, best model).** After
Task #1 (re-read the freshly-distilled PREFERENCES.md), you are **MANDATED** —
not merely invited to "consider" — to let the `[learned]` lines steer
generation. The run-brief carries the full directive ("GENERATION BACKPRESSURE"
section); in short:

1. **Bias toward `[learned]` loves.** Choose the topic/format/style/depth a
   `[learned]` line favors over an equally-novel alternative the panel is silent
   on. Your generation choice echoes the same bias the selection ranker applied.
2. **`promote` = COMMISSION.** A `[learned]` promote-signal is a standing order
   to EXPAND that thread into a DEEPER artifact (a promoted insight-card's topic
   → an article or micro-podcast this run), not a compliment. Treat promoted
   cards as a queue of deeper-artifact commissions.
3. **`less` / `already_knew` = active SUPPRESSION.** A `[learned]` hide-signal
   means do NOT generate that lead/topic this run, even if a transcript surfaces
   it — spend the cap elsewhere.
4. **The exploration reserve + novelty critic STILL bind.** Backpressure shapes;
   it never overrides "is this genuinely novel?". Generate from the rotating
   deep-dive thread on its own merits even when it matches NO preference. And a
   preference-matching lead that fails the adversarial novelty critic is still
   killed — preference never resurrects a non-novel angle.

**The headless generation runner** (`scripts/run-generation.ts`): given the
brief path, it builds the `claude -p` invocation (system prompt = the agent's
marching orders: read the brief, run the artifact skills with the adversarial
novelty critic, respect `MAX_ARTIFACTS_PER_RUN`, save to `artifacts/`, append
the ledger), captures the agent's stdout/result to
`index/runs/<ts>/generation-log.txt`, then learns what shipped by diffing
`artifacts/` before vs after the run. It returns a structured summary
`{ created:[{type,slug,novelty}], killed:[], duration, exit_code }` and never
hard-fails on a zero-artifact (or non-zero-exit) run — zero artifacts is valid.
Model defaults to `opus` (Hunter's best-model default), overridable via
`$MEET_GEN_MODEL` or `--model`.

The orchestrator writes a per-run dir `index/runs/<ts>/` containing
`run-brief.md` + `run-log.json`, and appends a one-liner to
`index/run-log.jsonl` (spec §7 — the Generate button polls this). The brief is
also printed to **stdout** so you can consume it directly.

## What the orchestrator surfaces (and what it never does)

The brief lists, for the recency window + the one deep-dive pick: **title,
date, path, source, and the index's short match-context snippets** — never
transcript bodies. It also embeds the **feedback summary** (the deterministic
`summarize-events.ts` aggregation — the agent's distill-preferences input), the
current `PREFERENCES.md` (a pre-distill, last-known-good snapshot the agent
re-reads after editing), and a prior-artifact baseline summary. **It never calls
an LLM and never publishes** — including the `[learned]` PREFERENCES.md edits,
which are the agent's first task, not the orchestrator's. `--dry-run` makes the stop-at-brief explicit; a non-dry run still
stops at the brief because generation is your job — the difference is only what
the run-log records.

## Steps 5–6 — your judgment (after the brief)

0. **Close the preference loop FIRST (distill-preferences, MANDATORY).** Before
   you read a single transcript for generation, turn the feedback into
   preferences. The brief embeds the **feedback summary** (the deterministic
   `summarize-events.ts` aggregation). Following
   `skills/distill-preferences/SKILL.md`: read that summary, open the artifacts
   it points at that carry real signal (`less` / `wrong` / `promote` / any
   note), and update **only the `[learned]` bullets** in `PREFERENCES.md` —
   never the human-authored (untagged) lines. Be conservative (**≥2 consistent
   signals** before a generalization; cite the evidence counts in each bullet).
   **Zero updates is a valid result.** Then **re-read `PREFERENCES.md`** and
   generate against the freshly-updated file — NOT the pre-distill snapshot
   embedded in the brief. This step is the only thing that turns reactions into
   learned preferences; do it every run.
1. **Read the actual transcripts** at the paths in the brief (the orchestrator
   only surfaced paths). The recency set is "what's new"; the deep-dive is one
   older thread the cursor rotated to.
2. **Generate** with the existing skills — `extract-insights`,
   `write-article`, `make-podcast`, `illustrate-card` — each running its own
   `novelty-scan` + the **mandatory adversarial-novelty critic** baked into
   those skills. Honor the cap in the brief (`MAX_ARTIFACTS_PER_RUN`, default 3;
   backfill 25): publish the **best ≤ cap**. **Zero artifacts is a valid run.**
   **Let PREFERENCES.md STEER this (generation backpressure — MANDATORY, not
   optional).** Bias topic/format/depth toward `[learned]` loves; treat a
   `[learned]` `promote` signal as a COMMISSION to expand that thread into a
   deeper artifact (promoted card topic → article/podcast); treat `less` /
   `already_knew` as active SUPPRESSION (drop that lead). The exploration reserve
   (the deep-dive thread) and the novelty critic still bind — generate the
   deep-dive on its own merits even if it matches no preference, and never let
   preference resurrect a lead the critic killed. (Full directive in the brief's
   "GENERATION BACKPRESSURE" section.)
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

**The deep-dive is preference-AGNOSTIC on purpose (the exploration reserve).**
Unlike the recency pool (which IS preference-weighted — see Backpressure above),
the deep-dive ranker takes only the novelty proxy; the `[learned]` preference
signal is never wired into it. This is the anti-filter-bubble guarantee: the
deep-dive is the discovery channel for asymmetric knowledge Hunter doesn't yet
know he wants, so it must not be steered by existing tastes.

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
| DISTILL (aggregate) | the `summarize-events.ts` aggregation failed → no feedback summary to embed; proceed with the **existing PREFERENCES.md** (last-known-good); log a warning; the brief notes it's degraded and tells the agent to run the aggregation itself before its distill judgment |
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
