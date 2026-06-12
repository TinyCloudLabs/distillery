# distillery — Corpus Navigation + Autonomous Feed Generation SPEC

2026-06-11 · Status: design doc for review (NOT implemented). Reviewer: Hunter.

This spec extends the base [SPEC.md](../SPEC.md) with the machinery that turns
the existing one-shot generation skills into an **autonomous heartbeat**: a
local cron that walks the whole transcript corpus, generates artifacts, and
auto-publishes survivors to the feed. It introduces two new deterministic
skills (`index-corpus`, `query-corpus`), one saved orchestration recipe (the
**feed run**), a separate **backfill** excavation mode, and the launchd
plumbing that makes it durable across reboots.

Nothing here relitigates base-SPEC decisions. The judgment-vs-plumbing
principle is preserved exactly: **scripts surface, the agent judges, no model
calls in scripts.** The new skills are corpus *navigation* — they tell the
agent *where to look*; the existing generation skills (`extract-insights`,
`write-article`, `make-podcast`, `illustrate-card`) and the novelty analyzers
(`novelty.ts`) do the looking and judging unchanged.

---

## 0. Decisions already locked (do not relitigate)

| # | Decision |
|---|---|
| D1 | **Trigger = local launchd → headless `claude -p`.** Not a cloud scheduled agent. Uses the `reference_claude_cli_headless` recipe (`claude -p "<msg>" --system-prompt "<full override>" --model <m>`). The same launchd footprint also keeps the feed server + tunnel alive across reboots. |
| D2 | **Run scope = recency window + one rotating deep-dive.** Each run processes transcripts newer than the last run, PLUS exactly one high-novelty older thread never yet surfaced. A persisted cursor advances the deep-dive each run. |
| D3 | **Auto-publish.** Survivors land straight in `artifacts/` (the feed reads it live). No staging tray. Revealed-preference actions (`already_knew`, `less`) prune after the fact via existing feedback machinery. |
| D4 | **distill-preferences runs BEFORE generation each run** so the latest feedback shapes the same run's output. |

---

## 1. Three-layer architecture

```
┌─ Layer 3 — SCHEDULE + DURABILITY (launchd) ─────────────────────────┐
│  plist: feed-run (weekday morning)  →  runs the recipe headless     │
│  plist: feed-server + tunnel keep-alive (KeepAlive across reboot)   │
└────────────────────────────────────────────────────────────────────┘
                              │ invokes
┌─ Layer 2 — THE FEED-RUN RECIPE (orchestration) ─────────────────────┐
│  a saved workflow (prompt + ordered steps) the agent executes:      │
│  index → distill-prefs → query → generate → critic → save/publish   │
│  THIS is where judgment lives. The recipe is the agent's runbook.   │
└────────────────────────────────────────────────────────────────────┘
                              │ calls
┌─ Layer 1 — DETERMINISTIC SKILLS (plumbing) ─────────────────────────┐
│  index-corpus   build/refresh corpus-index.json (incremental)       │
│  query-corpus   retrieve transcript paths + match context           │
│  (+ existing: novelty-scan, extract/survey/digest, save, verify)    │
│  NO model calls. Pure surfacing. Same contract as every skill today.│
└────────────────────────────────────────────────────────────────────┘
```

**Why these are the boundaries.** Layer 1 is reusable by any agent (Claude
Code, Hermes, Codex) and any trigger; it has no opinion about scheduling or
publishing. Layer 2 is a *prompt*, not code — it's how the agent is told to
sequence Layer 1 + the existing generation skills, and it's where all
selection/quality judgment happens. Layer 3 is OS plumbing with zero distillery
logic. A change to the schedule never touches a skill; a change to a skill never
touches launchd.

---

## 2. `index-corpus` skill

**Purpose.** Maintain a fast, incremental index of the whole transcript corpus
so the agent (and `query-corpus`) never re-parse ~394 files per run. Surfacing
only — the agent decides nothing here.

### Inputs

- `TRANSCRIPT_DIRS` env var: comma-separated absolute dirs. Nothing hardcoded.
  On Hunter's machine these resolve to the three real folders under
  `~/Obsidian Vaults/TinyCloud 2025/Team Relays/TinyCloud Team Space/`:
  `Fireflies-Transcripts`, `Gemini-Transcripts`, `Soundcore-Transcripts`.
  The skill reads the env var; the README documents the example value; no path
  is ever written into code (same rule as base SPEC).
- CLI also accepts positional dir/file paths to override/augment the env var
  (for tests + ad-hoc runs).

### Script contract

```sh
bun harness/index-corpus/scripts/index-corpus.ts \
  [<dir-or-file>...] \
  [--index-path index/corpus-index.json] \
  [--full]            # ignore hashes, re-process everything
  [--prune]           # drop index records whose source file no longer exists
```

Resolution order for dirs: positional args → else `$TRANSCRIPT_DIRS` →
else error listing every source it checked (mirrors `getSecret`'s
error-listing stance).

Behavior:

1. Walk each dir (reuse `loadTranscripts`' file collection: `.md`/`.txt`,
   recursed, dotfiles skipped).
2. For each file, compute a **content hash** (sha256 of raw bytes — `Bun.CryptoHasher`,
   already used in `harness/feed/src/app.ts`). If the hash matches the existing index
   record, skip (no re-parse). Only new/changed files are parsed.
3. Parse via `parseTranscript` (with the **Soundcore adapter**, §4).
4. Derive per-transcript record (below), reusing the novelty analyzers'
   shapes where they exist:
   - `entities` / `terms` from the same extraction used by
     `findSingleVoiceTopics` (capitalized phrases + stopword-filtered domain
     words) — factored into a shared helper so the index and the scan agree.
   - `quantities` from `extractQuantities` / `trackQuantities` per-transcript
     mentions (money/percent/count/deadline with context + provenance).
   - `speakerTurnCounts` matches the `survey.ts` digest field name already in
     `write-article`.
5. Write `corpus-index.json` (atomic: write tmp, `rename` — same pattern as
   `harness/feed/src/app.ts`). `--prune` removes records for vanished files.

### Persistence location

`index/corpus-index.json` at repo root. **Gitignored** (add `/index/` to
`.gitignore`) — it's derived AND contains meeting content (entities, quote
context, speaker names). Same treatment as `artifacts/` and `feedback/`.

### JSON schema

```jsonc
{
  "version": 1,
  "generated_at": "2026-06-11T14:00:00Z",
  "transcript_dirs": ["/abs/Fireflies-Transcripts", "..."],
  "transcripts": [
    {
      "path": "/abs/.../2026-06-08-....md",   // key (absolute)
      "source": "fireflies",                   // fireflies | gemini | soundcore | unknown
                                               //   (derived from containing dir name)
      "title": "Transcript Sharing MVP Planning Meeting",
      "date": "2026-06-08",                    // transcript.date (header/frontmatter)
      "speakers": ["Sam", "Hunter", "Patrick"],
      "speakerTurnCounts": { "Sam": 76, "Hunter": 71, "Patrick": 36 },
      "turnCount": 183,
      "duration": "23 min",                    // transcriptDuration()
      "entities": ["OpenKey", "Flashbots", "..."],   // single-voice-style entities
      "terms": ["permissioning", "transcript", "..."], // stopword-filtered domain words
      "quantities": [
        { "kind": "money", "value": "$100k", "speaker": "Sam",
          "timestamp": "12:56", "context": "...close the round at $100k by..." }
      ],
      "content_hash": "sha256:…",              // raw-bytes hash for change detection
      "indexed_at": "2026-06-11T14:00:00Z",
      "empty": false                            // true for skipped-empty Soundcore files
    }
  ],
  "warnings": ["/abs/bad.md: parse error — kept previous record"]
}
```

- `empty: true` records are kept (so we don't re-parse them every run) but are
  excluded from query results by default.
- Parse failures are warnings, never throws — a bad file keeps its prior record
  (or is recorded as empty), matching `priorArtifactIndex`'s never-throw stance.

---

## 3. `query-corpus` skill

**Purpose.** Retrieve from the index — answer "which transcripts match this
window/speaker/entity/term/source, and which have I already surfaced?" Returns
paths + match context; the agent reads the actual transcripts it points at.

### Script contract

```sh
bun harness/query-corpus/scripts/query-corpus.ts \
  [--index-path index/corpus-index.json] \
  [--since 2026-06-04] [--until 2026-06-11]   # date window (inclusive)
  [--speaker "Sam"] [--entity "OpenKey"] [--term permissioning] [--source soundcore]
  [--artifacts-dir artifacts]                  # for the surfaced join
  [--ledger index/surfaced.json]               # persisted surfaced-topics ledger
  [--unsurfaced-only]                          # drop already-surfaced matches
  [--limit N] [--format json|md]
```

Filters AND together. With no filters it returns the whole index (capped by
`--limit`). All filtering is over the index — `query-corpus` never re-reads
transcript files.

### The "already surfaced" join

Two sources, unioned:

1. **Prior-artifact baseline** — reuse `priorArtifactIndex(artifactsDir)`. A
   transcript appearing in any artifact's `source_transcripts[]` is "surfaced."
   This is the authoritative record (it survives even if the ledger is lost).
2. **Surfaced-topics ledger** — `index/surfaced.json` (gitignored). A persisted
   append log the recipe updates after each run, recording per-transcript +
   per-topic-key what was surfaced *and the deep-dive cursor*. It lets the run
   mark a transcript "examined, nothing shipped" so backfill/deep-dive don't
   re-chew it. Schema:

   ```jsonc
   {
     "version": 1,
     "deepdive_cursor": { "last_path": "/abs/.../2026-05-12-....md" },
     "surfaced": [
       { "path": "/abs/.../x.md", "topic_keys": ["openkey,permissioning"],
         "run_id": "2026-06-11T14:00Z", "outcome": "shipped|examined-no-ship",
         "mode": "recency|deepdive|backfill" }
     ]
   }
   ```

### Output shape

```jsonc
{
  "query": { "since": "2026-06-04", "source": "soundcore", "...": "..." },
  "matches": [
    {
      "path": "/abs/.../2026-06-08-....md",
      "source": "soundcore", "date": "2026-06-08", "title": "...",
      "matched_on": ["since", "source"],          // which filters this hit
      "match_context": ["...$100k by Friday...", "...OpenKey delegation..."],
      "surfaced": true,
      "surfaced_by": ["artifact:insight-card/foo", "ledger:2026-06-04T14:00Z"]
    }
  ],
  "counts": { "total": 12, "surfaced": 5, "unsurfaced": 7 }
}
```

`--format md` renders the same data as a readable report (same convention as
`novelty-scan`).

---

## 4. The Soundcore parser adapter

**Investigated against the 15 real files** in
`.../Soundcore-Transcripts/2026-06/` (read-only). Soundcore `.md` is its own
dialect; described generically below (no meeting content reproduced):

**Format A — Soundcore non-empty.** Structure:
```
# <Title>
**Date:** <YYYY-MM-DD>
**Duration:** <N min>

## Summary
**Time**: …  **Location**: …  **Related Personnel**: …
## Summary                      ← yes, "## Summary" appears twice
<WH-question prose: **What**: … / **Who**: … / **When**: … blocks,
 organized under several ## <Topic> and ### <Subtopic> headings>
…
## Transcript                   ← the REAL diarized turns start here, often far down
**speaker1:**                   ← speaker label ALONE on its line…
<turn text on the FOLLOWING line(s)>   ← …text on the next line, blank-line separated
**Hunter:**
<turn text>
```

**Format B — Soundcore empty.** No turns at all:
```
# <timestamp title>
**Date:** …
**Duration:** 0 min
## Transcript
_(No transcript segments available.)_
```

### Two real bugs found (verified by running the current parser)

1. **Empty files leak.** Running the current `parseTranscript` on the empty
   file yields **1 unattributed turn** whose text is the entire file
   (`# … **Date:** … ## Transcript _(No transcript segments available.)_`) —
   the plain-text fallback swallows the metadata + placeholder. These must
   produce **zero turns** and be flagged `empty` so the index skips them and
   generation never sees them.

2. **WH-question / summary prose risk.** The pre-`## Transcript` body is full of
   `**What**:`, `**Who**:`, `**Related Personnel**:` bold lines. `META_LINE_RE`
   /`BOLD_TURN_RE` can read these as metadata or as phantom speaker turns. The
   current parser mostly survives *this* corpus because the real turns dominate
   and the WH prose sits in `## Summary`/`## <Topic>` sections (not the turn
   region) — but it's fragile: the gate is "metadata only before the first
   turn," and a `**What**:` line before `## Transcript` is exactly that shape.
   The block-form turns (`**speaker1:**` alone on a line) DO currently parse,
   but only by accident of the fallback append logic.

### The fix — a Soundcore adapter, format-detected

Add a **format-detection + adapter** layer in `transcript.ts`, not a rewrite:

1. **Empty detection (all formats, cheap + high-value):** if, after parsing,
   the only turns are the plain-text fallback AND the raw body matches
   `_(No transcript segments available.)_` (or yields zero real speaker turns
   under a `## Transcript` heading), mark the transcript `empty` and emit
   `turns: []`. `loadTranscripts` already tolerates empties; `index-corpus`
   records `empty: true`; `query-corpus` excludes them; generation skips them.

2. **Soundcore detection:** a transcript is Soundcore when its raw text has a
   `## Transcript` heading AND the body before it contains the WH-summary
   signature (`**What**:` / `**Who**:` lines, or a duplicated `## Summary`).
   Cheap regex sniff; falls back to generic parsing if unsure.

3. **Soundcore adapter behavior:**
   - Treat **everything before the FINAL `## Transcript` heading** as
     non-turn material (route the WH prose into `summary`, never into turns).
     This hardens the "metadata only before first turn" gate against the
     `**What**:` bold lines.
   - Parse the turn region with the existing `BOLD_TURN_RE`, which already
     handles `**speaker1:**`-alone-on-a-line followed by text on the next
     line — keep that, just scope it to the post-`## Transcript` region.
   - Normalize generic speaker labels (`speaker1`, `speaker2`) but keep
     human-named labels (`Sam`, `Hunter`, `Tina (Flashbots)`) verbatim.

**Decision:** do this as a detection branch inside `parseTranscript` (one new
`parseSoundcore` path + a shared empty-check), NOT a separate file the caller
must choose. Callers keep calling `parseTranscript`/`loadTranscripts`
unchanged — the dialect is invisible above the boundary, exactly like the base
SPEC's "Listen adapter behind `loadTranscripts`" principle. Add fixtures
(synthetic, never real content) for: Soundcore-with-turns, Soundcore-empty,
and the WH-prose-before-transcript trap.

---

## 5. The feed-run recipe (the saved workflow)

A saved prompt/runbook the headless agent executes top to bottom. It is the
orchestration layer — *all* selection and quality judgment happens here, via the
existing skills. Lives at `harness/feed-run/SKILL.md` (so any agent can run it
manually too) and is what the launchd job invokes.

### Ordered pipeline

```
1. INDEX        bun harness/index-corpus/scripts/index-corpus.ts --prune
2. DISTILL      run distill-preferences  (feedback → PREFERENCES.md)   [D4]
3. QUERY        a) recency:  query-corpus --since <last_run> --unsurfaced-only
                b) deepdive: pick ONE high-novelty, never-surfaced older
                   transcript past the cursor; advance cursor
4. GENERATE     for the selected transcripts, run the existing generation
                skills (extract-insights / write-article / make-podcast +
                illustrate-card), each running its own novelty-scan + critic
5. CRITIC       the mandatory + adversarial-novelty critic already baked into
                every generation skill; zero artifacts is a valid run
6. SAVE/PUBLISH save.ts writes survivors straight to artifacts/ (auto-publish,
                [D3]); append to index/surfaced.json (path, topic_keys,
                outcome, mode); persist advanced deepdive_cursor
```

### Parameters

| param | default | meaning |
|---|---|---|
| `RECENCY_SINCE` | last successful run's timestamp (from `surfaced.json`); first run = 7 days | lower bound for the recency query |
| `DEEPDIVE_PER_RUN` | 1 | older threads excavated per run ([D2]) |
| `MAX_ARTIFACTS_PER_RUN` | 3 | **cost guardrail** — hard cap on artifacts a run may publish (across recency + deep-dive). The agent picks the best ≤3; quality-beats-quantity already biases low. |
| `MAX_ILLUSTRATE` | = artifacts published | one hero image per artifact, capped by the same number |

### Deep-dive cursor

Persisted in `surfaced.json.deepdive_cursor.last_path`. Selection each run:
`query-corpus --unsurfaced-only` over all-but-recent transcripts, ranked by a
deterministic novelty proxy (drift-group membership + single-voice entity
count, both already computable from the index), take the first past
`last_path` in a stable ordering (date then path). After processing, set
`last_path` to that transcript. The cursor advances exactly one transcript per
run and wraps when it reaches the end (re-eligibility is still gated by the
surfaced join, so wrapping doesn't re-surface).

### Per-step failure degradation

Each step degrades gracefully; the run never hard-fails on a single step:

| step fails | behavior |
|---|---|
| INDEX | abort the run (everything downstream depends on a fresh index) and log; the feed is unchanged, server keeps serving the last artifacts |
| DISTILL | proceed with the **existing PREFERENCES.md** (last-known-good); log a warning |
| QUERY (recency) | if window empty → skip to deep-dive only; not an error |
| QUERY (deepdive) | if no eligible older transcript (all surfaced) → recency-only run |
| GENERATE/CRITIC | a single skill failure drops that candidate, not the run; zero artifacts is a valid run |
| SAVE | per-artifact: a failed save drops that artifact; others still publish; cursor only advances if the deep-dive transcript was actually examined |

All step outcomes append to a structured run log (§7) so a failed/empty run is
inspectable.

---

## 6. The BACKFILL run mode

A **separate one-time excavation** over the full ~394-transcript history
(336 Fireflies + 43 Gemini + 15 Soundcore), distinct from the daily heartbeat.
It exists to mine the back-catalog once so the daily run can stay cheap and
recency-focused.

- **Invocation:** same recipe, `--mode backfill` (or a sibling
  `harness/feed-run/SKILL.md` section). Differences from the daily run:
  - **Query:** no recency window; iterate the *entire* index in novelty-ranked
    batches (e.g. process the top-N drift groups + single-voice clusters first),
    rather than one deep-dive per run.
  - **Budget:** a larger, explicit one-time cap — `MAX_ARTIFACTS_BACKFILL`
    (proposed **25**, Hunter-tunable) — and run in **batches** with a
    checkpoint, so it can be paused/resumed and the spend is bounded per batch.
  - **Coverage recording:** every transcript backfill *examines* (shipped or
    not) is written to `surfaced.json` with `mode: "backfill"` and
    `outcome: examined-no-ship | shipped`. This is the mechanism that stops the
    daily run from re-surfacing backfilled topics — the daily deep-dive cursor
    and `--unsurfaced-only` both honor the same ledger.
- **One-and-done:** backfill is run manually (not on launchd). After it
  completes, the daily heartbeat takes over with the back-catalog already
  marked covered.

---

## 7. launchd setup

Two plists. They live in the repo at `harness/ops/launchd/` (templated, with
`__REPO__`/`__HOME__` placeholders), installed by a `harness/ops/install-launchd.sh`
that fills the placeholders and copies to `~/Library/LaunchAgents/`. Logs go to
`~/Library/Logs/distillery/`.

### (a) Scheduled feed run — `xyz.tinycloud.distillery.feed-run.plist`

- `StartCalendarInterval`: weekday mornings (e.g. Mon–Fri 08:30).
- `ProgramArguments`: a wrapper script `harness/ops/feed-run.sh` that:
  1. `cd $REPO`
  2. exports env (`TRANSCRIPT_DIRS`, `GEMINI_API_KEY`/`GOOGLE_AI_API_KEY` — TTS
     + image steps need it; index/query/distill don't) from a sourced
     `harness/ops/feed-run.env` (gitignored).
  3. invokes the recipe headless:
     ```bash
     claude -p "Run the distillery feed-run recipe (daily mode). \
       Read harness/feed-run/SKILL.md and execute its ordered pipeline." \
       --system-prompt "$(cat harness/ops/feed-run.system.md)" \
       --model opus
     ```
     Per the `reference_claude_cli_headless` recipe, `--system-prompt` fully
     overrides the default prompt so the headless run is clean (no SessionStart
     hook chatter). `--model opus` — generation quality matters (Hunter's
     best-model default).
- **PATH note:** launchd has a minimal PATH; the wrapper must export a PATH that
  includes the `claude` CLI and `bun` (resolve their real locations at install
  time and bake them into `feed-run.env`). `EnvironmentVariables` in the plist
  can't see the login shell.
- `StandardOutPath`/`StandardErrorPath` → `~/Library/Logs/distillery/feed-run.log`.
- The wrapper appends a one-line run summary (mode, artifacts published, cursor)
  to a structured `index/run-log.jsonl` (gitignored).

### (b) Server + tunnel keep-alive — `xyz.tinycloud.distillery.feed-server.plist`

- Runs `harness/feed/` server (`bun src/server.ts`) + the tunnel (cloudflared) under
  `KeepAlive: true` and `RunAtLoad: true`, so a reboot brings both back without
  Hunter. This subsumes the earlier-deferred "server + tunnel durability"
  problem.
- Either one plist running a small supervisor script, or two plists (server,
  tunnel) — **decision: two plists**, so the tunnel can restart independently of
  the server. Both `KeepAlive`.
- Server needs `OPENKEY_ALLOWED_ADDRESSES` (front-door allowlist) and optionally
  `ARTIFACTS_DIR` in its env file.

### Install / inspect / uninstall

`harness/ops/install-launchd.sh` does `launchctl bootstrap gui/$(id -u) <plist>` for
each; README documents `launchctl kickstart` (run-now), `launchctl print` (status),
and `launchctl bootout` (uninstall). No `crontab` — launchd only.

---

## 8. The feed "Generate" affordance

A button in the feed UI that fires the **same recipe** on demand, so Hunter can
force a run without waiting for the cron.

- **Contract:** `POST /api/generate` (gated, same OpenKey front-door as every
  `/api/*` route — see `harness/feed/src/auth.ts`). Body: `{ mode?: "daily" | "backfill", dry_run?: boolean }`.
  Returns `202 { run_id }` immediately and spawns `harness/ops/feed-run.sh` as a detached
  child; the route does NOT block on generation.
- **Status:** `GET /api/generate/:run_id` reads `index/run-log.jsonl` for that
  run's progress/outcome; the UI polls it. (Reuses the structured run log from §7.)
- **Auth implication:** generation spends money (Gemini TTS + images) and writes
  to the published feed — it MUST stay behind the gate. Never expose it under
  `AUTH_DISABLED=1` reachable from the network; treat `/api/generate` as the
  highest-privilege route. A `dry_run` mode (generate, critic, but don't publish)
  is the safe default for the button's first version.
- **v1 stance:** **optional.** The cron (Layer 3) is the primary trigger and
  ships first. The button is a convenience that reuses the exact same wrapper —
  spec it now, build it after the cron is proven. For v1 it can ship as
  **docs only** ("to force a run: `launchctl kickstart …` or run `harness/ops/feed-run.sh`")
  and graduate to the HTTP route once concurrency (§10) is handled.

---

## 9. Cost model

Subscription vs metered split:

- **Claude / agent reasoning = subscription.** The headless `claude -p` run
  uses Hunter's Claude Code subscription auth — **no per-token API bill** (the
  whole reason for the local-launchd / `claude -p` choice, per the recipe memo).
- **Gemini = metered** (the only real cash cost). From base SPEC: image
  ≈ **$0.039** each; TTS is Gemini `gemini-2.5-flash-preview-tts` (priced per
  audio token, small for 2–5 min episodes — call it **~$0.01–0.05** per episode,
  flagged as estimate pending a live token count).

**Per daily run** (cap `MAX_ARTIFACTS_PER_RUN = 3`):

| item | unit | worst-case ×3 |
|---|---|---|
| hero image (1 per artifact) | $0.039 | $0.117 |
| podcast TTS (only if an artifact is a podcast) | ~$0.03 | ~$0.09 |
| index/query/distill/text | $0 (deterministic + subscription) | $0 |

→ **≤ ~$0.20/run**, realistically less (most artifacts are cards/articles with
one image, no audio). Weekday cadence ≈ **$1/week**, **~$4/month** of Gemini.

**Backfill one-time** (cap `MAX_ARTIFACTS_BACKFILL = 25`): ≤ 25 images +
some podcasts ≈ **$1–2 one-time**. Index build over 394 files is $0 (no model
calls). Cheap because the agent reasoning is subscription-covered; only the
media generation meters.

---

## 10. Open questions + risks

| # | Risk | Mitigation / open question |
|---|---|---|
| R1 | **Concurrency** — cron run fires while Hunter taps Generate (or two crons overlap). | A **lockfile** (`index/.run.lock`, written by `harness/ops/feed-run.sh`, PID + start time, removed on exit/trap). A second run aborts early with "run in progress." `POST /api/generate` checks the lock and returns `409` if held. Decide: queue vs reject — **propose reject** (simplest; runs are frequent enough). |
| R2 | **Index + ledger contain meeting content.** | Gitignore `/index/` (entities, quote context, speaker names) exactly like `artifacts/` and `feedback/`. Already the stance for derived personal data. |
| R3 | **A transcript edited after being surfaced.** | The `content_hash` detects the edit at index time → record re-processed. But the surfaced-join keys on path, so an edited transcript stays "surfaced." Open question: do we re-eligible a materially-changed transcript? **Propose:** store the `content_hash` in the `surfaced.json` entry; if the hash changes, the recency/deep-dive query may re-offer it (the novelty critic still guards against re-surfacing the same angle). Flag for Hunter. |
| R4 | **Hermes as a future consumer.** | These skills are agent-agnostic by construction (SKILL.md + bun scripts, no model calls). A future Hermes agent can call `index-corpus`/`query-corpus`/the generation skills directly — the recipe is just a prompt Hermes could also run. No design change needed; note it so we don't accidentally couple the recipe to Claude Code specifics (keep the wrapper thin, keep judgment in SKILL.md). |
| R5 | **launchd PATH / env drift** — `claude`/`bun` not found, or `GEMINI_API_KEY` missing under launchd's minimal env. | Bake absolute tool paths + a sourced env file at install time; `feed-run.sh` fails loudly to the log if a tool or key is absent. |
| R6 | **Empty/garbage Soundcore files** (15:05:32-style) silently producing junk artifacts. | The §4 empty-skip is the guard; add a fixture test so a regression can't reintroduce the leak. |
| R7 | **Auto-publish with no human gate (D3)** could ship a bad artifact to the live feed. | Accepted by D3; the adversarial-novelty critic + `MAX_ARTIFACTS_PER_RUN` are the quality guards, and revealed-preference (`less`/`already_knew`) prunes after. The `dry_run` button (§8) is the manual escape hatch. |

---

## 11. Phased build plan → PRs

Each phase is a reviewable PR (per Hunter's PR-per-phase convention). Build
order chosen so the deterministic, testable plumbing lands first and the
agent-orchestration + OS plumbing land on top of a proven base.

| PR | Scope | Ships value |
|---|---|---|
| **PR1 — Soundcore adapter** | `transcript.ts` format detection + `parseSoundcore` + empty-skip; synthetic fixtures (with-turns, empty, WH-trap); typecheck + tests. | The corpus parses correctly end-to-end (today it leaks empties). Unblocks everything. |
| **PR2 — index-corpus** | new skill (SKILL.md + script), `corpus-index.json` schema, incremental hashing, `--full`/`--prune`, `/index/` gitignore, tests. | Fast repeated corpus access; foundation for query + recipe. |
| **PR3 — query-corpus** | new skill, filters, surfaced-join (prior-artifact + `surfaced.json` ledger), output shapes, tests. | The agent can ask "what's new / what's unsurfaced." |
| **PR4 — feed-run recipe (manual)** | `harness/feed-run/SKILL.md` ordered pipeline, recency + deep-dive cursor, `MAX_ARTIFACTS_PER_RUN`, failure-degradation, `surfaced.json` writes. Run it **by hand** end-to-end on the real corpus as live verification. | The autonomous loop works — just hand-triggered. The whole product, minus the timer. |
| **PR5 — launchd** | `harness/ops/launchd/*.plist`, `install-launchd.sh`, `feed-run.sh` wrapper, env files, logging, lockfile (R1), server+tunnel keep-alive plists. | The heartbeat + durability. The system runs itself. |
| **PR6 — backfill mode** | `--mode backfill`, larger budget, batch/checkpoint, coverage recording. Run once. | Back-catalog mined; daily run stays cheap. |
| **PR7 (optional) — Generate button** | `POST /api/generate` + status route + UI affordance + `dry_run`. | On-demand trigger from the feed. Only after R1 concurrency is handled. |

### Build-order recommendation

**Ship PR1 → PR4 first as one coherent milestone** — that's the entire
corpus-navigation + autonomous-generation engine, manually triggered and fully
testable, with no OS or scheduling risk. Verify it live on the real ~394-file
corpus (this is the moment to confirm Soundcore parsing, cursor advance, and
that auto-publish populates the feed). **Then PR5 (launchd)** to make it a
heartbeat, **then PR6 (backfill)** as a one-time excavation, and **PR7 (button)**
last and optional. Rationale: the highest-uncertainty, highest-value work
(parsing the real corpus + the orchestration recipe) is also the most testable;
the OS plumbing is low-uncertainty and should sit on a proven base, not the
other way around.
