# Skill: query-corpus

Retrieve from the corpus index — answer *"which transcripts match this
window / speaker / entity / term / source, and which have I already
surfaced?"* It returns transcript **paths + match context** and an
**already-surfaced** mark; the agent then reads the actual transcripts the
paths point at and judges. **Surfacing only** — no model calls, no judgment
here.

Like every distillery skill: the **script does deterministic plumbing** (filter
the index, join the surfaced ledger, format); **no model calls** happen here.
All filtering is over `index/corpus-index.json` — `query-corpus` **never
re-reads transcript files** (that is `index-corpus`'s job, done once).

## Prerequisites

- bun installed. No API key — deterministic plumbing.
- A built index at `index/corpus-index.json` (run `index-corpus` first). A
  missing/corrupt index is graceful: zero matches, never a throw.

## Procedure

Run from the distillery repo root.

```sh
bun skills/query-corpus/scripts/query-corpus.ts \
  [--index-path index/corpus-index.json] \
  [--since 2026-06-04] [--until 2026-06-11]   # inclusive date window \
  [--speaker "Sam"] [--entity "OpenKey"] [--term permissioning] \
  [--source soundcore] \
  [--artifacts-dir artifacts]      # prior-artifact surfaced baseline \
  [--ledger index/surfaced.json]   # persisted surfaced-topics ledger \
  [--unsurfaced-only]              # drop already-surfaced matches \
  [--include-empty]                # include flagged-empty records \
  [--limit N] [--format json|md]
```

- **Filters AND together.** With no filters it returns the whole index (capped
  by `--limit`). Date bounds are inclusive; speaker/entity/term match
  case-insensitively; `--source` is one of `fireflies|gemini|soundcore|unknown`.
- **Empty records are excluded** by default (flagged-empty Soundcore files
  carry no content); `--include-empty` overrides.
- The result is printed to **stdout** (json or md) so it can be piped; the
  **counts** line goes to stderr.

## The "already surfaced" join (spec §3)

A transcript is marked `surfaced: true` if it appears in **either** source —
the two are unioned, and `surfaced_by` lists the provenance:

1. **Prior-artifact baseline** — `priorArtifactIndex(artifactsDir)` from
   `novelty.ts`. A transcript in any artifact's `source_transcripts[]` is
   surfaced. This is **authoritative**: it survives even if the ledger is lost.
   Provenance tag: `artifact:<type>/<slug>`. Path matching tolerates
   absolute-vs-relative form (artifacts store "the input paths as given") by
   also keying on basename.
2. **Surfaced ledger** — `index/surfaced.json`, the persisted append log the
   feed-run recipe updates after each run. It lets a run mark a transcript
   *"examined, nothing shipped"* so the deep-dive / backfill don't re-chew it.
   Provenance tag: `ledger:<run_id>`.

`--unsurfaced-only` drops every surfaced match — this is how the recipe asks
*"what's genuinely new?"* for the recency window and the deep-dive candidate
set.

## The surfaced ledger + deep-dive cursor (spec §3 / §5)

`index/surfaced.json` (gitignored — it records meeting paths + topic keys):

```jsonc
{
  "version": 1,
  "deepdive_cursor": { "last_path": "/abs/.../2026-05-12-....md" },
  "surfaced": [
    {
      "path": "/abs/.../x.md",
      "topic_keys": ["openkey,permissioning"],
      "run_id": "2026-06-11T14:00Z",
      "outcome": "shipped",            // shipped | examined-no-ship
      "mode": "recency",               // recency | deepdive | backfill
      "content_hash": "sha256:…"       // R3: hash at surfacing time (optional)
    }
  ]
}
```

- `surfaced` is an **append log**: the same path can appear across runs; the
  query union dedupes by path for the mark and lists each run in `surfaced_by`.
- `outcome: examined-no-ship` still counts as surfaced — that's the whole point
  (don't re-chew a thread a prior run already judged and passed on).
- `content_hash` supports R3 (a transcript edited after surfacing): the recipe
  MAY re-offer it when the index hash changes. `query-corpus` does not act on
  this by default — surfaced keys on path.

### Cursor advance / wrap semantics

`surfaced-ledger.ts` exposes `advanceCursor(ledger, orderedCandidates)`,
the **mechanical** rotation the feed-run recipe drives once per run:

- The recipe builds the candidate list with
  `query-corpus --unsurfaced-only` over all-but-recent transcripts, ranked by a
  deterministic novelty proxy, then sorted stably (date then path).
- `advanceCursor` finds `last_path` in that ordered list and returns the
  candidate **after** it as `next`, moving the cursor to `next`.
- **Wrap:** if `last_path` is at/after the end (or no longer in the candidate
  set), it wraps to the **first** candidate (`wrapped: true`). With **no
  cursor yet** (first run) it starts at the first candidate (not a wrap).
- An **empty candidate list** yields `next: undefined` and leaves the cursor
  unchanged — a recency-only run.

Wrapping never re-surfaces, because the candidate list is already
`--unsurfaced-only`: a transcript surfaced on a previous lap is no longer a
candidate, so the wrap lands only on still-new threads.

## Output shape

```jsonc
{
  "query": { "since": "2026-06-04", "source": "soundcore", "unsurfaced_only": true },
  "matches": [
    {
      "path": "/abs/.../2026-06-08-....md",
      "source": "soundcore", "date": "2026-06-08", "title": "...",
      "matched_on": ["since", "source"],          // which active filters hit
      "match_context": ["...$100k by Friday...", "...OpenKey delegation..."],
      "surfaced": true,
      "surfaced_by": ["artifact:insight-card/foo", "ledger:2026-06-04T14:00Z"]
    }
  ],
  "counts": { "total": 12, "surfaced": 5, "unsurfaced": 7 }
}
```

Matches are sorted **newest first** (undated last), then by path. `match_context`
is best-effort evidence pulled from the index (quantity contexts that mention a
filtered entity/term, else the first few quantity contexts, else the matched
entity/term itself) — never a transcript re-read.

`--format md` renders the same data as a readable report (same convention as
`novelty-scan`).

## Selection backpressure — the preference signal (spec phase 2A)

`scripts/preference-signal.ts` makes PREFERENCES.md a **control valve on
selection**, not just generation. It is DETERMINISTIC and model-free (a
regex/keyword parse + an additive score — same plumbing stance as the rest of
this skill):

- `parsePreferenceSignal(markdown)` reads ONLY the `- [learned]` bullets,
  partitions them into **loved** (Topics/Style/Formats, or any `more` / `keep` /
  `promote` / `landing` wording) vs **disliked** (Novelty-bar, or any `less` /
  `skip` / `already_knew` / `table stakes` wording), strips the trailing
  evidence parens, harvests stopword-filtered keywords (incl. hyphenated handles
  like `single-voice-thesis`), and tallies per-keyword weights. A keyword that
  is both loved and disliked is dropped from both (neutral). **Human (untagged)
  lines never feed the signal** — they steer via the agent's judgment
  downstream, not the deterministic ranker.
- `scorePreferenceMatch(record, signal)` scores one index record (title +
  entities + terms, no transcript re-read): each loved-keyword hit ADDS its
  weight, each disliked-keyword hit SUBTRACTS it, and every hit records WHERE it
  matched for transparent logging.

**Where it is wired (the anti-filter-bubble split).** The **feed-run recipe**
uses this to re-rank the **recency pool** (`rankRecencyByPreference` in
`feed-run-lib.ts`) so preference-matching new transcripts rise. The **rotating
deep-dive cursor is left preference-AGNOSTIC** — the exploration reserve for
asymmetric knowledge. The signal is deliberately never wired into
`rankDeepDiveCandidates`. See `skills/feed-run/SKILL.md` → Backpressure.

## Consumers

- The **feed-run recipe** runs `query-corpus --since <last_run> --unsurfaced-only`
  for the recency window (then preference-weights it — see above), and
  `--unsurfaced-only` (no window) to build the deep-dive candidate set it feeds
  to `advanceCursor`.
- After a run it appends to `index/surfaced.json` (path, topic_keys, outcome,
  mode, content_hash) and persists the advanced `deepdive_cursor`.
