# distillery — SPEC v0.1

2026-06-10 · Status: scaffold + shared plumbing built; artifact skills next.

## Vision

TinyCloud's meetings and conversations carry insight that evaporates after
the call. distillery turns transcripts into durable, shareable artifacts:

- **Illustrated insight cards** — surprising claims, decisions, recurring
  topics, asymmetric knowledge held by one person, anchored to exact quotes.
- **Editorial articles** — longer-form pieces with generated images,
  developed from one transcript or threads across a collection.
- **Micro-podcasts** — short audio digests of what mattered.

The skills are agent-agnostic: any coding agent (Claude Code, Codex,
Cursor) reads a `SKILL.md`, runs small bun scripts for the deterministic
work, and applies its own judgment for selection and writing. Artifacts
land in a feed UI later (pulse-radio Card pattern); v1 is skills only.

## Architecture

### Skills layout

```
skills/
  _shared/lib/          shared plumbing (secrets, transcript, artifact, gemini)
  extract-insights/     SKILL.md + scripts/   ← the template skill
  illustrate-card/      (next phase)
  write-article/        (next phase)
  make-podcast/         (next phase)
```

One skill = one folder = `SKILL.md` + `scripts/*.ts`. **Agent provides
judgment; scripts provide plumbing.** Each skill is independently callable:
no skill requires another to have run, and none assumes anything about the
machine beyond bun + (where needed) a Gemini key. Transcript paths are
always invocation-time arguments — never hardcoded.

### Input contract v1 — source-agnostic transcripts

Skills consume plain transcript files (`.md`/`.txt`) from paths passed in.
`loadTranscripts(paths)` accepts files or directories (recursed) and
normalizes everything to one `Transcript` shape (`transcript.ts`):
frontmatter or Fireflies/Gemini-sync headers (title, date, participants,
duration), optional Summary / Action Items sections, speaker-attributed
turns with optional timestamps, plain-text fallback, plus the raw text for
quote verification.

**Future: Listen adapter.** Listen is a multiplexer aggregating transcripts
in TinyCloud. When it lands, it becomes another producer of `Transcript[]`
behind the same boundary — an adapter that fetches from TinyCloud instead
of disk. Skills don't change. (Not built in v1.)

Example corpus on Hunter's machine (documentation only, never referenced in
code): `~/Obsidian Vaults/TinyCloud 2025/Team Relays/TinyCloud Team
Space/Fireflies-Transcripts` — 336 Fireflies .md files in `YYYY-MM/`
folders. Tests use small synthetic fixtures, never real meeting content.

### Secrets — vault-first with env fallback

`getSecret(name)` in `_shared/lib/secrets.ts` resolves in order:

1. **TinyCloud secrets vault** (secrets.tinycloud.xyz): key
   `secrets/<NAME>` in the `secrets` space. The headless transport
   (tc CLI / `@tinycloud/node-sdk`) is being verified by a parallel spike;
   `fetchFromVault` is a stub marked `TODO(vault-spike)` and the chain is
   structured so landing it is a one-function swap.
2. **Env vars**: the secret's own name, with aliases for Gemini mirroring
   pulse-radio's `resolveGeminiKey` precedence —
   `GOOGLE_AI_API_KEY` > `GEMINI_API_KEY` > `GOOGLE_API_KEY`.

When nothing resolves, the error lists every attempted source. Artifact
skills are unblocked on env vars even before the vault transport lands.

### Artifact output contract — feed-ready

Every skill writes `artifacts/<type>/<slug>/artifact.json` with media files
(hero image, audio) alongside in the same folder, referenced by relative
file name. The `Artifact` type (`_shared/lib/artifact.ts`) is modeled on
pulse-radio's `Card` so the future feed UI consumes it directly:

```
id, type ("insight-card" | "article" | "podcast"), headline, body?,
quote?, attribution?, tags[], source_transcripts[], source_quotes[]?,
hero_image?, audio?, generated_at, generation_model?,
quality { critic_pass, quotes_verified, notes? }
```

Validation is plain TS (`validateArtifact`) — no runtime deps, so any
agent's bun can run the scripts. `writeArtifact` validates before
persisting; scripts refuse to write contract-invalid artifacts.

**Future: feed UI.** A pulse-radio-style card feed reads the artifacts/
folders (or a Listen-synced store). Out of scope for this repo's v1; the
contract above is the interface.

### Quality architecture (top priority)

Artifact quality beats artifact quantity. Every artifact skill runs an
explicit quality loop modeled on pulse-radio's artifactory stages:

```
extract → triage → draft → critic → verify-quotes → save
(script)  (agent)  (agent)  (agent)   (script)       (script)
```

Requirements every skill's SKILL.md must enforce:

1. **Quote anchoring.** Every claim/quote in an artifact is anchored to
   exact transcript lines via `source_quotes[]`. The
   `verify-quotes` script checks each quote verbatim
   (whitespace-insensitive) against its transcript;
   `quality.quotes_verified` may only be set after the script passes.
2. **Mandatory critic pass.** The agent re-reads each draft as a skeptical
   editor and discards sub-bar candidates rather than padding output.
   Zero artifacts is a valid result. `quality.critic_pass: true` only on
   survivors; `quality.notes` records what was cut and why.
3. **Quality block in the contract.** `quality { critic_pass,
   quotes_verified, notes? }` is a required field — an artifact without it
   fails validation, so quality state is always inspectable downstream
   (the feed UI can badge or filter on it).

### Gemini clients

`_shared/lib/gemini.ts`:

- `generateImage({prompt, aspectRatio?})` — Nano Banana
  (`gemini-2.5-flash-image`), lifted from pulse-radio's provider including
  the imageConfig/aspectRatio retry. ~$0.039/image.
- `generateText({prompt, model?, system?, temperature?})` — defaults to
  `gemini-2.5-flash`.

Both resolve keys via `getSecret("GEMINI_API_KEY")` unless given one.

## Artifact types

| Type | Skill (planned) | Media | Notes |
| --- | --- | --- | --- |
| insight-card | extract-insights (+ illustrate step) | hero image | v1 template skill ships extract/verify/save; illustration next phase |
| article | write-article | inline/hero images | editorial long-form from one or many transcripts |
| podcast | make-podcast | audio file | micro-podcast digest; **TTS default: Gemini TTS (assumption — flagged, see below)** |

## Build phases

1. **Scaffold + shared plumbing** (this phase, done): repo, SPEC, secrets
   chain, transcript parser, artifact contract, gemini clients,
   extract-insights template skill, tests.
2. **Vault transport** (parallel spike → swap into `fetchFromVault`).
3. **Artifact skills**: illustrate-card (image gen on insight cards) →
   write-article → make-podcast. Each copies the extract-insights pattern
   and the quality loop.
4. **Listen input adapter**: Transcript[] from TinyCloud instead of disk.
5. **Feed UI consumer**: pulse-radio-style card feed over artifacts/.

## Decisions log

- **2026-06-10** Skill format: `SKILL.md` + CLI bun scripts per skill
  folder — agent-agnostic (Claude Code / Codex / Cursor all work).
- **2026-06-10** Skills for different artifact types are independently
  callable; no inter-skill dependency.
- **2026-06-10** Input contract v1 is source-agnostic plain files; Listen
  integration designed as a future adapter behind `loadTranscripts`.
- **2026-06-10** Repo name: **distillery**.
- **2026-06-10** Secrets: vault-first (`secrets/<NAME>` in the TinyCloud
  `secrets` space) with env-var fallback mirroring pulse-radio precedence.
- **2026-06-10** Quality architecture is the top priority: explicit
  extract → triage → draft → critic → verify-quotes loop; required
  `quality` block in the artifact contract; critic pass discards rather
  than pads.
- **2026-06-10** No hardcoded machine paths anywhere in skills/ or lib
  code; transcript paths are invocation-time arguments.

## Assumptions

- **Podcast TTS = Gemini TTS** (e.g. `gemini-2.5-flash-preview-tts`).
  Assumption pending confirmation; swap is isolated to the make-podcast
  skill when built.
- **Plain-TS validation instead of zod** to keep the repo dependency-free
  (skills runnable by any agent with bare bun). Revisit if contracts grow.
- **`source_transcripts` is an array** (the brief said `source_transcript`
  singular) because collection-derived artifacts (recurring topics across
  meetings) are an explicit goal.
- **Artifact slug = slugified headline** (max 64 chars); collisions
  overwrite. Fine for v1 volumes; add a uniqueness suffix if it bites.
- **Text model default `gemini-2.5-flash`** for the text helper; callers
  can pass any model id.
- **Quote verification is whitespace-insensitive, case-insensitive
  substring match** against the raw file — strict enough to kill
  paraphrase, loose enough to survive markdown line wrapping.
- **YAML frontmatter parsed as simple `key: value` lines only** (title,
  date, source) — no YAML lib; nested YAML is out of scope for transcripts.
