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

### Secrets — env vars (v1)

`getSecret(name)` in `_shared/lib/secrets.ts` resolves from env vars only:
the secret's exact name, with aliases for Gemini mirroring pulse-radio's
`resolveGeminiKey` precedence —
`GOOGLE_AI_API_KEY` > `GEMINI_API_KEY` > `GOOGLE_API_KEY`. When nothing
resolves, the error lists every attempted source. Keys canonically live in
the TinyCloud Secret Manager (secrets.tinycloud.xyz) and are copied into
env / `.env` manually for now.

Internally getSecret walks an ordered resolver chain (currently just the
env resolver), so a vault resolver can be added later as one function.

### Future: TinyCloud secrets vault integration

Deferred from v1. The spike verdict (2026-06-10, `../distillery-spike/
spike.mjs`) was **no headless access today**:

- **Browser path proven** (pulse-radio): vault unlock + `secrets/<NAME>`
  reads in the `secrets` space work with a signed-in TinyCloudWeb instance.
- **Headless blocked**: the vault master key requires the root OpenKey
  passkey signature — user presence by design. The SDK's signature cache is
  `isBrowser()`-gated; the only session key on disk is for the wrong space
  (no secrets-space delegation exists on disk); and no tc CLI is installed.
  This is a TinyCloud product gap, not a distillery bug.
- **Candidate transports evaluated** (pick one when this phase opens):
  1. one-time vault → `.env` sync tool (browser unlock, writes local env);
  2. local gateway daemon — persistent browser profile + Hono server on
     127.0.0.1 that proxies vault reads;
  3. true headless via a secrets-space delegation + exported
     master-signature bootstrap.

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

#### Novelty architecture

Artifacts must surface synthesis the attendee couldn't do in the room —
the consumer ATTENDED the source meetings, so a well-executed summary is
a failed artifact. Same division of labor as everything else: scripts
deterministically SURFACE candidates, the agent JUDGES (no LLM calls in
scripts). `_shared/lib/novelty.ts` + the `novelty-scan.ts` CLI provide
three analyzers, run alongside every skill's survey step:

1. **Quantified-claim drift** (`trackQuantities`): money / percent /
   count-with-unit / deadline mentions extracted from spoken turns
   (regexes grounded on real Fireflies speech: "$100k", "100 grand",
   "3 to 5 million bucks", "20%", "by Friday"), with context + speaker /
   transcript / timestamp provenance, grouped across transcripts by fuzzy
   topic key and ordered chronologically. The script lines up the
   evidence; whether "$100K to close" → "eventually" is drift is agent
   judgment.
2. **Single-voice topics** (`findSingleVoiceTopics`): capitalized
   entities + stopword-filtered domain words that exactly ONE speaker uses
   corpus-wide, with a per-mention engagement signal (substantive reply
   within 3 turns) — asymmetric-knowledge candidates.
3. **Prior-artifact baseline** (`priorArtifactIndex`): headlines / tags /
   quotes / sources from `artifacts/*/*/artifact.json` (gitignored, read
   at runtime) — what's already been surfaced. Candidate angles a prior
   artifact covered are disqualified unless materially advanced.

Workflow requirements (make-podcast is the primary statement; write-article
and extract-insights mirror it): the lead MUST come from a
quantified-drift finding, a single-voice topic, or a cross-transcript
connection no single speaker stated — "interesting summary" is
disqualified; and after the standard critic, an **adversarial novelty
critic** argues the team already knows everything in the draft (plainly
stated in an attended meeting, or in a prior artifact). Lead falls →
kill the artifact (zero is valid); beats fall → cut them. Verdicts land
in `quality.notes` under the `[novelty] lead=<type>: ...` convention.

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
2. **Artifact skills**: illustrate-card (image gen on insight cards) →
   write-article → make-podcast. Each copies the extract-insights pattern
   and the quality loop.
3. **Vault transport** (deferred; pick a candidate transport from "Future:
   TinyCloud secrets vault integration" and add it as a resolver).
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
- **2026-06-10** Secrets: env vars mirroring pulse-radio precedence; the
  TinyCloud Secret Manager (`secrets/<NAME>` in the `secrets` space) is the
  canonical key home, copied manually for now.
- **2026-06-10** v1 env-vars-only; vault deferred (headless access blocked
  by passkey security; spike at `../distillery-spike/spike.mjs`).
- **2026-06-10** Quality architecture is the top priority: explicit
  extract → triage → draft → critic → verify-quotes loop; required
  `quality` block in the artifact contract; critic pass discards rather
  than pads.
- **2026-06-10** No hardcoded machine paths anywhere in skills/ or lib
  code; transcript paths are invocation-time arguments.
- **2026-06-10** Phase 2 artifact skills landed (illustrate-card,
  write-article, make-podcast); Gemini TTS shape grounded on
  ai.google.dev speech-generation docs, live-unverified pending
  `GEMINI_API_KEY`.
- **2026-06-10** Phase 2.5 live quality eval complete — 4 illustrated
  cards, 1 article, 1 podcast generated from real corpus; TTS + image
  pipelines live-verified first-try; review.html + feed UI shipped;
  3 rounds of dogfood fixes applied.
- **2026-06-11** Novelty mechanisms added — drift/single-voice/baseline
  scripts (`novelty.ts` + `novelty-scan.ts`) + adversarial novelty critic
  in every artifact skill; per Hunter: artifacts must surface synthesis
  the attendee couldn't do in the room — a well-executed summary is a
  failed artifact.

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
