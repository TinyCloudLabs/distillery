# Skill: index-corpus

Maintain a fast, **incremental, content-hash-gated** index of the whole
transcript corpus so the agent (and `query-corpus`) never re-parse the ~394
files every run. **Surfacing only** — this skill decides nothing; it builds a
JSON index of what each transcript contains (entities, terms, quantities,
speakers) and the corpus navigation skills + generation skills judge from it.

Like every distillery skill: the **script does deterministic plumbing** (walk,
hash, parse, derive, persist); **no model calls** happen here. The Soundcore
adapter is invisible behind `parseTranscript`, so all three real sources
(Fireflies / Gemini / Soundcore) index through one path; flagged-empty
recordings are recorded `empty: true` and excluded from query results, never
parsed into junk turns.

## Prerequisites

- bun installed.
- No API key required — deterministic plumbing.
- Transcript dirs available via `$TRANSCRIPT_DIRS` (comma-separated absolute
  dirs) or passed as positional args. On Hunter's machine the env var resolves
  to the three folders under
  `~/Obsidian Vaults/TinyCloud 2025/Team Relays/TinyCloud Team Space/`:
  `Fireflies-Transcripts`, `Gemini-Transcripts`, `Soundcore-Transcripts`.
  **Nothing is hardcoded** — the skill reads the env var; this README only
  documents the example value.

## Procedure

Run from the distillery repo root.

```sh
bun skills/index-corpus/scripts/index-corpus.ts \
  [<dir-or-file>...] \
  [--index-path index/corpus-index.json] \
  [--full]    # ignore hashes, re-process everything
  [--prune]   # drop index records whose source file no longer exists
```

**Dir resolution order:** positional args → else `$TRANSCRIPT_DIRS` → else an
error listing every source it checked (mirrors `getSecret`). The default index
path is `index/corpus-index.json` at the repo root.

**What it does:**

1. Walk each dir (`.md`/`.txt`, recursed, dotfiles skipped) — same file
   collection rule as `loadTranscripts`.
2. Content-hash each file (sha256 of raw bytes). **If the hash matches the
   existing index record, the file is loaded from the index — NOT re-parsed.**
   Only new or changed files are parsed. `--full` forces a re-parse of
   everything.
3. Parse via `parseTranscript` (Soundcore adapter included).
4. Derive the per-transcript record (schema below), reusing the novelty
   analyzers' shared extraction (`extractTranscriptTerms`,
   `collectQuantityMentions`) so the index and `novelty-scan` agree on what
   counts as an entity vs. a domain term vs. a quantity.
5. Write `corpus-index.json` atomically (tmp + `rename`). `--prune` removes
   records for files that no longer exist on disk; without it, records for
   files outside the current input scope are carried forward unchanged.

Output is **counts + keys only** on stderr (e.g. `reprocessed`, `unchanged`,
`pruned`, `empty`, `warnings`). It NEVER prints transcript content.

The index lives at `index/corpus-index.json` and is **gitignored** (`/index/`)
— it is derived AND contains meeting content (entities, quote context, speaker
names), the same treatment as `artifacts/` and `feedback/`.

## Incremental behavior (the point)

- **Second run, nothing changed:** every file's hash matches → `reprocessed: 0`,
  `unchanged: N`. Effectively free.
- **One file edited:** only that file's hash differs → it alone re-parses
  (`reprocessed: 1`), the rest load from the index.
- **A new file appears:** one new record (`added: 1`), everything else
  unchanged.
- **A file deleted:** its record is carried forward by default; pass `--prune`
  to drop it (`pruned: 1`).

## Error handling

Parse/read failures are **warnings, never throws**: a bad file keeps its prior
record if it had one (else it's skipped), matching `priorArtifactIndex`'s
never-throw stance. Warnings are listed in `index.warnings` and on stderr.

## JSON schema

`index/corpus-index.json`:

```jsonc
{
  "version": 1,
  "generated_at": "2026-06-11T14:00:00Z",   // ISO; when this build ran
  "transcript_dirs": ["/abs/Fireflies-Transcripts", "..."],  // resolved inputs
  "transcripts": [
    {
      "path": "/abs/.../2026-06-08-....md",   // KEY (absolute path)
      "source": "fireflies",                   // fireflies|gemini|soundcore|unknown
                                               //   (derived from containing dir name)
      "title": "Transcript Sharing MVP Planning Meeting",
      "date": "2026-06-08",                    // transcript.date (header/frontmatter)
      "speakers": ["Sam", "Hunter", "Patrick"],          // turn-count desc, then name
      "speakerTurnCounts": { "Sam": 76, "Hunter": 71, "Patrick": 36 },
      "turnCount": 183,
      "duration": "23 min",                    // transcriptDuration() (computed from
                                               //   timestamps when the header lies)
      "entities": ["OpenKey", "Flashbots", "..."],     // single-voice-style entities
      "terms": ["permissioning", "transcript", "..."], // stopword-filtered domain words
      "quantities": [
        { "kind": "money", "value": "$100k", "speaker": "Sam",
          "timestamp": "12:56", "context": "...close the round at $100k by..." }
      ],
      "content_hash": "sha256:…",              // raw-bytes hash for change detection
      "indexed_at": "2026-06-11T14:00:00Z",    // when THIS record was (re)built
      "empty": false                            // true for skipped-empty files
    }
  ],
  "warnings": ["/abs/bad.md: parse error — kept previous record"]
}
```

- `empty: true` records are **kept** (so they aren't re-parsed every run) but
  carry no entities/terms/quantities and are excluded from query results by
  default (`query-corpus`).
- `entities`/`terms`/`quantities` come from the SAME shared extraction the
  novelty scan uses, so a candidate surfaced in one is the same shape in the
  other.

## Consumers

- `query-corpus` filters this index (window / speaker / entity / term / source)
  and joins it against the surfaced ledger — it never re-reads transcript files.
- The feed-run recipe runs `index-corpus --prune` as step 1 of every run.
