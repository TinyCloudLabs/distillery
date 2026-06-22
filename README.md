# distillery

distillery turns TinyCloud's meetings and conversations into durable,
shareable artifacts — illustrated insight cards, editorial articles,
micro-podcasts, social posts, investor-update nuggets, quote cards, and
person briefs — distilled from transcripts.

It is built in **two layers**, and the boundary between them is the whole
point:

1. **Skills** — portable, agent-agnostic primitives. Each skill is a
   `SKILL.md` + small bun scripts. Any agent (Claude Code, Codex, Cursor,
   Hermes) reads the `SKILL.md`, passes transcript paths, and gets a
   contract-valid artifact back. Skills are independently callable, no skill
   depends on another, and they know **nothing** about distillery's
   schedule, feed, or approval flow — they just emit artifacts, stamped with
   metadata (`approval_status`, `audience`).

2. **the distillery harness** — the distillery-specific orchestration that
   runs the skills into a living system: the corpus index, the scheduled
   feed-run recipe, the feedback → `PREFERENCES.md` backpressure loop, and
   the Folio feed PWA. The harness is the **consumer** of the skills — it
   decides *when* to call *which* skill and *what to do* with the output
   (publish to the feed vs. hold for approval).

> Skills are the methods; the harness is the apparatus that runs them
> continuously.

The clean seam between the two layers is the artifact contract's metadata:
**skills STAMP `approval_status`/`audience`; the harness ROUTES on it.**
Neither needs the other's internals.

The directory layout mirrors the two layers exactly:

```
distillery/
├── skills/                  Layer 1 — portable, agent-agnostic artifact skills
│   ├── extract-insights/      internal miners …
│   ├── write-article/
│   ├── make-podcast/
│   ├── illustrate-card/       packaging
│   ├── banger-extractor/      outward drafts …
│   ├── investor-snippet/
│   ├── quote-card/
│   ├── person-brief/          on-demand
│   └── _shared/lib/           the shared skill library (artifact contract, transcript,
│                              novelty, gemini/tts, feedback, …) — imported across layers
│
├── harness/                 Layer 2 — distillery-specific orchestration
│   ├── index-corpus/          corpus index build/refresh
│   ├── query-corpus/          retrieval over the index
│   ├── distill-preferences/   feedback → [learned] PREFERENCES.md loop
│   ├── feed-run/              the saved feed-run recipe (runbook + orchestrator)
│   ├── feed/                  the Folio feed PWA (its own bun workspace)
│   └── ops/launchd/           launchd plists + feedrun.sh/server.sh wrappers
│
│   # runtime state + config live at the REPO ROOT (gitignored except PREFERENCES.md):
├── artifacts/               skill output the feed serves
├── feedback/                the revealed-preference event log
├── index/                   corpus index + surfaced ledger + run log
├── .quarantine/             killed drafts (recoverable)
├── PREFERENCES.md           the control valve (human + agent co-authored)
└── .env                     secrets (Gemini key, OpenKey allowlist, …)
```

Code references state dirs (`artifacts/`, `feedback/`, `index/`,
`PREFERENCES.md`) relative to the **repo root**, never the cwd or the app dir —
so the feed app under `harness/feed/` resolves the same `artifacts/` the
skills write.

---

## Layer 1 — Skills (portable, agent-agnostic)

One skill = one folder = `SKILL.md` + `scripts/*.ts`. **The agent provides
judgment** (selection, drafting, critic passes); **the scripts provide
plumbing** (parsing, chunking, quote verification, validation, persistence).
No script in any artifact skill calls a model — judgment lives in the agent.

### Internal miners — distill transcripts into feed-ready artifacts

- **extract-insights** — surprising claims, decisions, recurring topics, and
  asymmetric (single-voice) knowledge as `insight-card` artifacts. The
  template skill all others follow.
- **hot-take** — compact, quote-anchored internal takes saved as
  `insight-card` artifacts; faster than articles and designed to fill the Feed
  with small, sharp artifacts.
- **write-article** — an editorial `article` (headline, dek, ~400–900-word
  body, anchored pull-quotes) from one transcript or a collection.
- **make-podcast** — a 2–5 minute micro-`podcast` (script + synthesized
  audio) built around one through-line.
- **make-cheap-video** — the preferred Gemini/Veo `clip` path: two short
  Veo 3.1 Lite segments stitched into a ~15s video, then saved/published
  through the same `clip` artifact contract as `make-clip`.
- **plan-feed-mix** — the first-pass selection skill: chooses the intended
  artifact mix before generation, reserves a video slot when video is enabled
  in `auto` runs, and records explicit skip reasons in `mix-plan.md`.

### Outward drafts — born `approval_status: pending`, never auto-published

- **banger-extractor** — the single most non-obvious *earned secret* actually
  said, abstracted into ONE postable line for X (a `social-post`), with the
  customer/person/deal/number scrubbed.
- **investor-snippet** — one short, forwardable `investor-update-snippet`:
  a single credible signal framed for an investor DM, no hype.
- **quote-card** — the visual packaging lift: render a strong line from an
  **already-approved** artifact as a minimal text-on-image `quote-card`.

### On-demand — grounded prep, not feed content

- **person-brief** — a transcript-grounded pre-meeting dossier on one person
  (`person-brief`). The identity-grounding rule is load-bearing: every claim
  cited, every inference marked, no role ever fabricated.

### Packaging — adds media to an existing artifact

- **illustrate-card** — adds a `hero` illustration (Gemini image) to any
  contract-valid artifact directory.
- **make-clip** — the higher-control FAL/Seedance `clip` path: identity image
  + storyboard sheet + reference-to-video, used when continuity and visual
  specificity matter more than the default Gemini/Veo path.

### Corpus navigation + orchestration skills

- **index-corpus** — builds/refreshes an incremental, content-hash-gated
  `index/corpus-index.json` over `$TRANSCRIPT_DIRS` (entities, terms,
  quantities, speakers). Surfacing only, no model calls.
- **query-corpus** — retrieves transcript paths + match context from the
  index by window/speaker/entity/term/source, with an *already-surfaced*
  join. Never re-reads transcripts.
- **distill-preferences** — turns the feedback event log
  (`feedback/events.jsonl`) into `[learned]` bullets in `PREFERENCES.md`
  (the backpressure loop). Script aggregates; agent judges.
- **feed-run** — the saved orchestration recipe (the runbook the harness
  executes): index → distill-preferences → query → generate → critic →
  publish. Both a runnable orchestrator and a SKILL.md any agent can run by
  hand.

### Shared library — `skills/_shared/lib/`

```
secrets.ts        getSecret(): env-var resolver chain (vault deferred)
transcript.ts     parse/load/chunk transcripts (incl. Soundcore adapter), verify quotes
artifact.ts       the artifact output contract + writer + metadata (approval_status, audience)
novelty.ts        drift / single-voice / prior-artifact analyzers (surface, don't judge)
abstraction.ts    abstraction-ladder helpers for outward drafts (anti-leak)
slop-scrubber.ts  AI-slop tell detection for outward copy
compress.ts       AAC compression for podcast audio
tts.ts            Gemini TTS for make-podcast
gemini.ts         Gemini image (nano-banana) + text helpers
feedback.ts       the six feedback actions + event-log helpers
stopwords.ts      shared stopword list for entity/term extraction
```

### The artifact contract — the metadata seam

Every skill writes `artifacts/<type>/<slug>/artifact.json` with media files
(hero image, audio) alongside it, referenced by relative file name. The
`Artifact` type (`_shared/lib/artifact.ts`) is modeled on pulse-radio's
`Card` so the feed UI consumes it directly. Validation is plain TS — no
runtime deps, so any agent's bun can run the scripts.

Types: `insight-card`, `article`, `podcast` (internal) and `social-post`,
`investor-update-snippet`, `quote-card`, `person-brief` (outward). Two
metadata fields carry the seam between the layers:

- **`approval_status`** — `pending | approved`. Outward types default to
  `pending` (nothing outward-facing is approved by default); internal types
  ignore it.
- **`audience`** — `public | investors | internal`.

Skills **stamp** these. The harness **routes** on them.

### How any agent invokes a skill

1. Read the skill's `SKILL.md` (e.g. `skills/extract-insights/SKILL.md`).
2. Run its scripts with `bun skills/<skill>/scripts/<script>.ts <args>` from
   the repo root. Transcript paths (`.md`/`.txt` files or directories) are
   always passed as arguments — nothing is hardcoded to any machine.
3. The agent supplies judgment (selection, drafting, critic pass); the
   scripts supply plumbing.

Skills are independently callable — no skill depends on another having run.

### Rich-media smoke run

Use Smithers when the goal is to prove the Feed can carry every rich artifact
type in one controlled pass:

```sh
bun run smithers:media-smoke
```

The workflow is staged as `setup → clip → podcast → article → publish`, so a
slow video provider queue is visible as the clip node instead of hiding inside
one long opaque run. The default is local-only: it generates one video clip, one
podcast, and one article with a generated hero image under `.smithers/reports/`,
then writes per-stage JSON reports. Each report includes a `verification` block
that fails the run unless the expected artifact media exists: clip video,
podcast audio, and article hero image. To publish exactly those three proof
artifacts into the delegated Feed, run:

```sh
bun run smithers:media-smoke -- --input '{"publish":true}'
```

This is a spend-bearing operator test (FAL video + Gemini TTS/image). It bypasses
Claude editorial selection on purpose and calls the real skill scripts directly,
so failures point at the specific media skill or the delegated publish path.
If generation succeeds but publish needs retrying, `scripts/full-media-smoke.ts
--publish-existing <dir>` republishes an existing artifact directory without
rerunning video, audio, or image generation. Retry reports rediscover the local
artifact directories and verify the publish-side media flags/counts too.

---

## Layer 2 — the distillery harness (the orchestration)

The distillery harness is the distillery-specific machinery that runs the
skills continuously and decides what happens to their output. It is the
*consumer* of Layer 1.

- **The corpus index** (`index-corpus` + `query-corpus`) — a fast,
  incremental view of the whole ~394-transcript corpus so a run never
  re-parses every file. `index/` is gitignored (it holds meeting content).
- **The feed-run recipe** (`harness/feed-run/`) — the headless generation
  loop: index → distill-preferences → query (recency window + one rotating
  deep-dive) → generate (the miner skills, each with its novelty + critic
  pass) → critic → publish, under a per-run artifact cap. Designed to run
  headless via `claude -p` (subscription-covered reasoning; only Gemini media
  meters, ≈$4/month). See [docs/CORPUS-NAVIGATION-SPEC.md](docs/CORPUS-NAVIGATION-SPEC.md).
- **Smithers smoke gates** (`.smithers/workflows/`) — `artifact-type-smoke`
  targets one artifact format or the full format matrix and runs the relevant
  deterministic tests without publishing or model/media spend. `feed-composition-
  smoke` sits above individual skills: it verifies ordering/freshness
  backpressure, artifact mix planning, video-slot reservation, format diversity,
  published cap behavior, draft isolation, and
  same-signal dedup so a run remains a good feed rather than a pile of valid
  artifacts. `feed-loop-readiness` is the no-spend preflight for the delegated
  loop: it checks pushed repo state, Feed submodule alignment, active TinyCloud
  delegation, stale runner locks, media-provider readiness, and the deterministic
  agent/frontend/Smithers gates before a live run. The live `agent-run` and
  `agent-run-staged` workflows also accept
  `{"artifactType":"..."}` (`auto` by default) as a quality-gated generation
  bias for development runs; it nudges skill choice without forcing weak output
  and returns a `proof` block showing whether the target actually published.
- **The delegated Feed agent** (`harness/agent/`) — the HTTPS/browser path used
  by TinyFeed. It runs `listen-read → generate → publish` under the user's
  TinyCloud delegation, reads recent Feed interactions as weak-prior generation
  backpressure, logs heartbeats for long child stages, and reports published
  media from `tc-publish --json` so run status reflects the media keys that
  actually reached TinyCloud. `POST /agent/run` accepts optional `{ artifactType }`; run
  status then carries `targetArtifactType` + `proof`, including video/audio/image
  media checks for targeted rich artifacts.
  In `auto` runs with video enabled, generation reads `plan-feed-mix` first,
  writes `mix-plan.md`, and reserves one publishable slot for a Gemini/Veo clip
  attempt unless another explicit target takes priority. If no video ships, the
  run must state why instead of silently filling the feed with text artifacts.
  The live agent also persists a small Listen read cursor outside the repo and
  passes `--offset` into `tc-listen-read`, so repeated Feed-triggered runs rotate
  through transcript windows instead of reusing the same latest conversations
  every time.
  Before publish it stamps `raw_artifact.producer` with run/delegation
  provenance so Feed cards can show which delegated run produced each durable
  artifact.
- **The feedback → PREFERENCES.md backpressure loop** — the Folio feed logs
  six revealed-preference actions (`more`, `less`, `save`, `already_knew`,
  `wrong`, plus hide) to `feedback/events.jsonl`; `distill-preferences`
  distills them into `[learned]` bullets in `PREFERENCES.md`; the next run's
  miner skills read `PREFERENCES.md` before generating. A deterministic guard
  protects human-authored lines.
- **The Folio feed PWA** (`harness/feed/`) — a pulse-radio-style card feed over
  `artifacts/`. Behind an OpenKey passkey front-door (single-user allowlist,
  `/api/*` and `/media/*` gated). It serves the cards, records feedback,
  exposes the preferences panel (`GET/PUT /api/preferences`, ETag-guarded),
  and offers a **Generate** button (`POST /api/generate`) that fires the same
  feed-run recipe on demand. The embedded TinyFeed submodule composes its first
  page from a bounded newest-first window, keeping the newest artifact first
  while mixing nearby types/sources/runs so a successful run does not render as
  a raw cluster of similar cards. Its Preferences page also summarizes
  interactions as early/directional weak signal, matching the agent runner's
  backpressure posture.

### The routing seam (in flight)

The harness routes on the artifact metadata the skills stamp:

- **Internal artifacts** (insight cards, articles, podcasts, person briefs)
  publish to the feed.
- **Outward artifacts** (social posts, investor snippets, quote cards) are
  born `approval_status: pending` and route to an **approvals surface**.

> **Future / not yet built:** the approvals surface itself, and the wiring of
> the comms skills (banger-extractor, investor-snippet, quote-card,
> person-brief) into the automated feed-run recipe, are the next
> orchestration step. Today those skills are invoked directly by an agent;
> the feed-run loop drives the internal miners.

---

## Secrets

v1 is env-vars only: `getSecret("GEMINI_API_KEY")` reads
`GOOGLE_AI_API_KEY` | `GEMINI_API_KEY` | `GOOGLE_API_KEY` (in that order);
other secrets read their exact name. Keys canonically live in the TinyCloud
Secret Manager (secrets.tinycloud.xyz) — copy them into `.env` manually for
now (see `.env.example`). Direct vault integration is deferred; see
SPEC.md, "Future: TinyCloud secrets vault integration".

## Develop

```sh
bun install
bun test
bunx tsc --noEmit
```

## Artifact feed submodule

This repo vendors the TinyCloud artifact feed as a git submodule at
[`submodules/feed`](./submodules/feed). The feed is the pure-client frontend
that reads `xyz.tinycloud.artifacts` directly from TinyCloud and delegates
generation to the distillery backend.

When cloning this repo from scratch, clone with submodules:

```sh
git clone --recurse-submodules https://github.com/TinyCloudLabs/artifactory.git
```

If the repo was already cloned, or after pulling a change that updates the feed
submodule pointer, inflate it from the repo root:

```sh
bun run artifact:inflate
```

That initializes `submodules/feed`, installs the root distillery dependencies,
and installs the feed dependencies.

The Artifactory dev scripts run the vendored submodule, not the sibling
`../feed` checkout. If both repos are present and their HEAD commits differ,
`artifact:dev` and `artifact:frontend:check` print a drift warning with both
hashes. Use it as a reminder that standalone Feed changes are not available to
the Artifactory/Feed combo until they are pushed and the submodule pointer is
updated. Set `ARTIFACT_FEED_DRIFT=strict` to make that drift fail the frontend
check.

### Run frontend + distillery backend

Run both sides together:

```sh
bun run artifact:dev
```

This starts:

- distillery agent backend: `http://localhost:4097`
- feed frontend: `http://localhost:5173`

It also wires a matching local `AGENT_API_TOKEN` / `VITE_AGENT_TOKEN` for the
two processes.

For the OpenKey/WebAuthn path, prefer the Portless HTTPS launcher:

```sh
AGENT_API_TOKEN=local-claude-dev \
VITE_AGENT_TOKEN=local-claude-dev \
PORTLESS_PORT=1355 \
bun run artifact:dev:https
```

This starts the embedded Feed submodule at `https://feed.localhost:1355` and the
local agent at `https://agent.feed.localhost:1355`. The agent uses the restored
delegation in `~/.tinycloud-agent/tc-home`, runs generation through the local
Claude CLI session, and publishes to the delegated user's TinyCloud
`applications` space.

To run the two sides manually:

```sh
# Terminal 1: distillery backend
export AGENT_API_TOKEN=local-artifact-dev
export AGENT_ALLOWED_ORIGIN=http://localhost:5173
bun run artifact:backend

# Terminal 2: feed frontend
export VITE_AGENT_HOST=http://localhost:4097
export VITE_AGENT_TOKEN=local-artifact-dev
bun run artifact:frontend
```

### Test the stack

```sh
bun run artifact:frontend:check
bun run artifact:backend:smoke
bun run artifact:test
```

`artifact:frontend:check` runs the feed typecheck and production build.
`artifact:backend:smoke` starts the distillery backend on a temporary local port
and verifies `GET /agent/info`. `artifact:test` runs both checks and then the
distillery test suite.

The Folio feed app has its own workspace under `harness/feed/`:

```sh
cd harness/feed && bun install && bun run build && bun run start
```

See [SPEC.md](SPEC.md) for the architecture, decisions log, and the
corpus-navigation design in [docs/CORPUS-NAVIGATION-SPEC.md](docs/CORPUS-NAVIGATION-SPEC.md).
