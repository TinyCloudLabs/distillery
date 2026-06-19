# Distillery agent backend

A small HTTP server that holds a stable agent key (→ `did:pkh`), accepts a
user's TinyCloud **delegation**, and runs the artifact pipeline **under that
delegation** — publishing distilled artifacts to the **user's own**
`xyz.tinycloud.artifacts` space. The feed front end delegates the user's
Listen-read + artifacts-read/write scopes to this agent's DID, then hits
`/agent/run` to generate.

Runs locally (`bun`) for dev, and is **deployed live to a Phala CVM (TEE)** —
see `DEPLOY.md` for the live coordinates and the deploy/redeploy runbook.

## API contract

```
GET  /agent/info             → { did, name, permissions: PermissionEntry[] }            (public)
POST /agent/delegation       { serialized } → { ok, agentDid, delegationCid, spaceId, expiresAt }   (AUTH)
POST /agent/run              {} (uses the stored delegation) → { run_id, status:"queued" }           (AUTH)
GET  /agent/run/:run_id      → { run_id, status:"queued"|"running"|"done"|"error", startedAt, finishedAt?, published?: PublishedArtifact[], held?: HeldArtifact[], media?: RunMediaSummary, log?:string[], error? }
GET  /agent/runs             → { runs: [{ run_id, status, startedAt, finishedAt?, published?: PublishedArtifact[], held?: HeldArtifact[], media?: RunMediaSummary, log?:string[], error? }], lock?: { run_id, owner, pid, acquiredAt, ageMs, reclaimable } }   (public)
```

`PublishedArtifact` is `{ type, slug, media?: { heroImage, audio, video } }`.
`HeldArtifact` is `{ type, slug, reason }` for generated artifacts that were not
published, including approval-held outward drafts and rich-media artifacts held
by media preflight.
`RunMediaSummary` is `{ heroImages, audio, video }`.

`GET /agent/run/:run_id` includes a bounded tail of recent stage log lines, and
`GET /agent/runs` lists recent runs (newest first, capped at 25) with a smaller
bounded log tail so a client can detect an in-progress build and show useful
progress without loading full run scratch state. It also includes the shared
run-lock summary when the lock exists, so operators can see whether HTTP or a
Smithers workflow currently owns the runner and whether that lock is reclaimable.
`GET /agent/info` also exposes non-secret generation readiness, including hero
image provider state, podcast-audio/TTS provider state, video provider state,
and the current `AGENT_MEDIA_FOCUS`.

Publish media reporting is sourced from `tc-publish --json`, not from a later
best-effort reread of the run scratch directory. That means the API media counts
reflect what the publisher actually wrote to TinyCloud (`heroKey`, `audioKey`,
`videoKey`) and Feed can show accurate run-history badges such as `3 images`.
Generated-but-held artifacts are structured in `held[]` as well as logged, so
Feed and Smithers can show why a podcast/clip/draft did not become a durable row.
Before each published artifact is handed to `tc-publish`, the runner stamps
`raw_artifact.producer` with the agent pipeline, run id, delegated space,
delegation CID/expiry, requested target artifact type, and media focus. Feed
renders that block in each card's Data trail so a durable artifact can be traced
back to the delegated run that produced it.

Queued/running records are reconciled on read: if the last recorded progress log
is older than `AGENT_RUN_STALE_MS` (default 20 minutes), the server rewrites the
run to `error` with a stale-run explanation. This catches server restarts,
crashes, and lost child processes so Feed does not show an abandoned build as
running forever.

`POST /agent/run` and the Smithers agent-run workflows share a disk-backed run
lock at `<AGENT_RUNS_DIR>/agent-run.lock`, so only one delegated pipeline can
use the mutable tc profile at a time across processes. Done/error runs release
the lock during cleanup; stale or malformed locks are reclaimed before the next
run starts.

`permissions` advertises the scopes the user must delegate: Listen-read on
`xyz.tinycloud.listen` (SQL `conversations` read + KV `transcript` get/list) and
read/write on `xyz.tinycloud.artifacts` (SQL feed + KV media). The front end
splices these into the OpenKey manifest so they're covered in the signed recap.

### Auth (required on the two mutating endpoints)

`POST /agent/delegation` and `POST /agent/run` are credential-holding /
publishing endpoints, so each REQUIRES a per-install bearer token:

```
Authorization: Bearer <token>      # preferred
x-agent-token:  <token>            # equivalent alternative
```

The token comes from `AGENT_API_TOKEN` if set; otherwise the server **generates
one on first boot and persists it `0600` at `<AGENT_STATE_DIR>/api-token`**. The
token is **never printed to the log** — read it with `cat <AGENT_STATE_DIR>/api-token`
(the startup banner points you there). The front end sends it on every
`delegation`/`run` call. A missing/invalid token → `401`. `GET /agent/info` and
`GET /agent/run/:id` stay public.

### CORS

CORS is locked to a set of trusted browser origins via `AGENT_ALLOWED_ORIGIN`
(comma-separated, e.g. `https://feed.example.com,https://feed.example.xyz`) —
**never** the `*` wildcard. The server exact-matches the request `Origin`
against the set and reflects only the matched origin in
`Access-Control-Allow-Origin`. When `AGENT_ALLOWED_ORIGIN` is unset/empty, no
cross-origin request is reflected (same-origin / curl only).

### Delegation validation

`POST /agent/delegation` validates in two phases so an unvalidated grant is
**never activated**. PRE-activation (before `useDelegation`, `400` on failure):
size cap (`AGENT_MAX_DELEGATION_BYTES`, before parse), numeric `chainId` == the
agent's chain, expiry in the future, well-formed pkh `spaceId`, audience DID ==
THIS agent's `did:pkh` (no foreign audience), and the granted `resources[]` are a
SUBSET of the advertised `permissions` (no scope escalation; each resource must
target THIS delegation's space — a full pkh URI must match EXACTLY, so a
different owner's same-named space is rejected). POST-activation: the minted
session's space must equal the delegation's. The agent's `did:pkh` chain is
derived from `AGENT_CHAIN_ID`.

## Run

```sh
bun harness/agent/src/server.ts
```

Env (all optional):

| var | default | meaning |
|---|---|---|
| `AGENT_PORT` | `4097` | listen port |
| `AGENT_HOST_BIND` | `127.0.0.1` | bind address (loopback; a tunnel/front end connects via localhost) |
| `AGENT_API_TOKEN` | (generated + persisted) | per-install bearer token required on POST delegation/run; auto-generated + persisted (never logged) if unset |
| `AGENT_ALLOWED_ORIGIN` | (none) | trusted CORS origin(s), comma-separated; no wildcard, no reflection when unset |
| `AGENT_CHAIN_ID` | `1` | EVM chain the delegation must target |
| `AGENT_MAX_DELEGATION_BYTES` | `262144` | size cap on the serialized delegation payload |
| `TINYCLOUD_HOST` | `https://node.tinycloud.xyz` | node the agent signs into + the delegation targets |
| `AGENT_STATE_DIR` | `~/.tinycloud-agent` | CREDENTIALS + tc-home (outside the repo; never `--add-dir`'d — see "Credential placement"; dir `0700`) |
| `AGENT_RUNS_DIR` | `~/.tinycloud-agent-runs` (or `<AGENT_STATE_DIR>-runs`) | run scratch (corpus/artifacts), a SEPARATE root from credentials so the generate deny doesn't overlap the `--add-dir`'d scratch |
| `AGENT_RUN_STALE_MS` | `1200000` | queued/running run records with no progress log newer than this are reconciled to `error` on read/list |
| `AGENT_STAGE_HEARTBEAT_MS` | `30000` | child-stage heartbeat interval for Listen-read, generate, and publish progress logs |
| `AGENT_TC_PROFILE` | `delegated` | sandbox tc profile the delegation activates |
| `AGENT_NAME` | `Distillery Agent` | advertised in `/agent/info` |
| `AGENT_TRANSCRIPT_COUNT` | `5` | Listen transcripts pulled per run |
| `AGENT_TARGET_ARTIFACTS` | `3` | target number of publishable, Feed-visible artifacts per run; quality can produce fewer |
| `AGENT_MEDIA_FOCUS` | `balanced` | `balanced`, `podcast`, or `video`; dev/operator posture for proving richer media paths without forcing low-quality artifacts |
| `AGENT_GEN_MODEL` | `opus` | model for the headless `claude -p` generate step |
| `AGENT_GENERATE_PATH` | `~/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` | PATH for the scrubbed-env generate child (needs `bun` + `claude`) |
| `NODE_SDK_DIST` | (built js-sdk checkout) | override the `@tinycloud/node-sdk` dist path |

The generate step spawns `claude -p`, so `claude` must be on PATH (and logged
in). An optional Gemini key (`GOOGLE_AI_API_KEY` / `GEMINI_API_KEY` /
`GOOGLE_API_KEY`) lets the article get an illustrated hero; without one the
generation agent must leave `hero_image` unset rather than creating a fallback
placeholder.

## How the delegation threads into the skills (no skill changes)

The existing pipeline skills (`tc-listen-read`, `tc-publish`) already accept
`--space` and run `tc` through `skills/_shared/lib/tc.ts` (which forwards spawn
env). The tc CLI's config dir is `os.homedir()/.tinycloud` with no env override
— but `os.homedir()` honors `$HOME`. So:

1. `POST /agent/delegation` → `node.useDelegation(serialized)` mints a delegated
   session; `access.restorable` is projected into a **sandboxed** tc profile at
   `<AGENT_STATE_DIR>/tc-home/.tinycloud/profiles/<profile>/` (the Listen
   sidecar's profile-writer pattern: `profile.json` + `key.json` +
   `session.json`, `authMethod:"openkey"` so the CLI restores from
   `session.json` alone — no agent key on disk in the sandbox).
2. `POST /agent/run` runs each tc-backed stage with `env HOME=<sandbox>` +
   `--space <delegation.spaceId>`. The sandbox's default profile IS the
   delegated profile, so `tc` operates **as the delegator on the delegator's
   space** — never an owner/cli-test key (hard rule). The user's real
   `~/.tinycloud` is never touched.
3. The **generate** stage (`claude -p`) runs over UNTRUSTED transcript text, so
   it gets two layers of defense-in-depth: (a) a **scrubbed env** — an allowlist
   (claude/Gemini creds + the macOS keychain-session vars claude needs) with every
   secret-bearing var dropped; and (b) a **claude tool restriction** —
   `--allowedTools` auto-approves only file ops + `Bash(bun:*)`/`Bash(rm:*)` (the
   skill scripts + critic deletes), `--disallowedTools` hard-blocks `tc` + network
   tools (curl/wget/nc/ssh/scp) + keychain/env readers (security/env/printenv) +
   WebFetch/WebSearch + a path-scoped Read/Glob/Grep deny of `AGENT_STATE_DIR`,
   `--no-session-persistence` keeps the untrusted transcript out of `~/.claude`
   history, `--strict-mcp-config --mcp-config '{}'` prevents user/project MCP
   servers from starting inside the headless run, and `--add-dir` is scoped to ONLY `skills/` + the run's corpus +
   artifacts — **never `repoRoot`**, and the state dir lives outside the repo so
   the agent credentials are not under cwd or any `--add-dir` (see "Credential
   placement"). `$HOME` stays the **real** home —
   claude's login token lives in the macOS Keychain, bound to the real `$HOME`, so
   a minimal HOME makes `claude -p` report "Not logged in". **Caveat:** `bun` is
   required and turing-complete (`bun -e <js>`), so the tool denylist raises the
   bar but is NOT a sandbox — a prompt-injected read could still reach
   `~/.tinycloud` on disk. Full process/filesystem isolation is the **phase-2
   (Phala/TEE)** hardening. The other stages get the sandbox HOME.

## The pipeline (`POST /agent/run`)

`bootstrap → listen-read → generate → critic → publish`, all under the
delegation, into a per-run scratch dir (`<AGENT_RUNS_DIR>/<id>/`):

Each external child stage writes heartbeat progress at
`AGENT_STAGE_HEARTBEAT_MS`, so Feed can distinguish a live long-running stage
from a genuinely stale run. Generate-stage heartbeats include child-process
diagnostics (`pid`, elapsed time, stdout/stderr byte counts) plus an artifact
directory snapshot (`files`, total bytes, latest changed file, latest age). This
is intentionally visible in `GET /agent/run/:id` because a long Claude/media
step is healthy when files are still changing and suspicious when both process
output and artifact files stay flat.

During generation, heartbeats classify the artifacts already on disk as
publishable vs. held drafts, e.g. `1 publishable [article/foo] 1 held
[social-post/bar]`. When the child exits, the runner records a bounded stdout /
stderr tail so operators can see the final agent summary without opening the
run scratch.

1. **listen-read** — `tc-listen-read/listen-read.ts` pulls the user's Listen
   transcripts into the run's corpus. **Empty-Listen-safe:** 0 transcripts →
   the run completes with 0 artifacts (valid), skipping generate + publish.
2. **generate** — headless `claude -p` aims for up to
   `AGENT_TARGET_ARTIFACTS` publishable Feed artifacts first (article,
   insight-card, person-brief where earned), then may create one approval-held
   social-post draft (banger-extractor) if the material earns it. This ordering
   is load-bearing: held outward drafts do not fill the Feed. The target is a
   cap, not a quota; fewer artifacts is correct when the material does not clear
   the quality bar. Survivors stay in the run's artifacts dir with an
   adversarial critic + verify-quotes gate.
   `AGENT_MEDIA_FOCUS=podcast` makes the generator try to prove one real
   `make-podcast` audio artifact before filling the rest of the run, but only if
   a sustained through-line clears the podcast bar and Gemini TTS is configured.
   `AGENT_MEDIA_FOCUS=video` does the same for one `make-clip` artifact, but only
   when `FAL_KEY` and `AGENT_ENABLE_VIDEO=1` are set. `balanced` is the default:
   pick the strongest format for the material and do not force media variety.
3. **publish** — `tc-publish/publish.ts --json` upserts each survivor to the user's
   `xyz.tinycloud.artifacts` (KV media + SQL feed row, `approval_status='approved'`)
   and emits the written media keys for run-status observability.

Before publish, the runner preflights local media references. Empty, unsafe,
missing, or unsupported optional media (`hero_image`, plus incidental audio/video
on non-rich artifacts) is stripped from `artifact.json` and logged in the run
status so the artifact can still publish without broken Feed media. Required
rich-media artifacts are stricter: `podcast` must carry valid local audio and
`clip` must carry valid local video, or the artifact is held with a clear media
reason before `tc-publish` runs. This prevents one audio-less podcast shell or
missing-video clip from failing the whole publish stage after other artifacts are
ready.

**Publish-only — no schema bootstrap (team decision, 2026-06-14).** The agent's
delegation is intentionally minimal: Listen `[read]`, `artifacts/feed`
`[read,write]`, media KV, `interactions [read]` — NO write on `interactions` or
`control`. So the agent does **not** run the 3-DB `bootstrap-schema` (it would
401 on the interactions/control `CREATE TABLE` and crash). The **front end**
owns table creation (the owner's own session bootstraps `feed` + `interactions`
on connect). `tc-publish` only ever writes `feed` + `media` (a pure INSERT into
the pre-existing feed table), which the delegation covers; the agent never
writes `interactions`, preserving the §1 reader-write / agent-read split.
**Precondition:** the feed table must already exist (front-end bootstrap on
connect) — otherwise publish errors with "no such table: artifact".

This repo now carries a local Smithers workflow pack under `.smithers/` for
durable development workflows, backpressure planning, and run triage. The
`agent-run` workflow is a bridge that imports `runner.ts`, restores the
persisted delegation, and runs the same skill chain as `/agent/run` while
recording Smithers workflow state. Its output preserves the same
`published[].media` flags and `{ heroImages, audio, video }` aggregate counts as
the HTTP run API, so Smithers runs can prove media publication directly. The
production `/agent/run` endpoint still executes the pipeline directly through
`runner.ts`; migrating that endpoint onto stage-level Smithers tasks is the next
orchestration step. `runner.ts` exports the stage helpers
(`createPipelineContext`, `runListenReadStage`, `runGenerateStage`,
`runPublishStage`) so the Smithers workflow can reuse the same implementation
rather than growing a parallel pipeline. For local development checks, run:

```sh
bun run smithers:doctor
bun run smithers:ps
bun run smithers:dev-mode
bun run smithers:artifact-types
bun run smithers:composition
bun run smithers:agent-run
bun run smithers:agent-run:staged
```

`smithers:artifact-types` is the safe per-format smoke test: it targets one
artifact type (or `all`) and verifies registry/render routing, skill docs, and
the relevant deterministic Bun tests without publishing, invoking Claude, or
spending on media APIs. `smithers:composition` is the higher-level feed-quality
gate: it checks freshness/ordering/backpressure, the format-exploration reserve,
published-vs-draft cap behavior, and same-signal dedup. That belongs above the
individual skills because it evaluates whether a run makes a good feed, not
whether one artifact can be generated. Both smoke workflows also write
gitignored JSON reports under `.smithers/reports/` so the matrix details remain
inspectable even when the Smithers CLI only prints node success.

Examples:

```sh
bun run smithers:artifact-types
bunx smithers-orchestrator workflow run artifact-type-smoke --input '{"artifactType":"podcast"}'
bun run smithers:composition
```

Live Smithers agent runs can also request a target artifact type:

```sh
bunx smithers-orchestrator workflow run agent-run-staged --input '{"artifactType":"digest"}'
bunx smithers-orchestrator workflow run agent-run --input '{"artifactType":"podcast"}'
```

`artifactType` defaults to `"auto"` and may be any value in the artifact
registry. This is deliberately a quality-gated bias, not a quota: the runner
adds target-specific instructions to the generation prompt, but it still tells
the agent to skip weak, duplicate, or prerequisite-missing artifacts. Use the
smoke workflow first when testing routing for every type; use a live targeted
run only when you are ready to spend model/media budget and publish under the
active TinyCloud delegation.

For the local HTTPS browser loop, prefer the one-command Portless launcher:

```sh
PORTLESS_PORT=1355 bun run artifact:dev:https
```

It starts the embedded Feed submodule at `https://feed.localhost:1355` and the
local agent at `https://agent.feed.localhost:1355`, with a shared local bearer
token and `VITE_AGENT_CONFIG_OVERRIDE=1` so Feed ignores the committed production
agent config during Vite dev.

If Portless fails with `EPERM` on `~/.portless/proxy.log`, the current sandbox
cannot write Portless proxy state. Start this command outside the sandbox or
approve the unsandboxed local dev-server command, then rerun
`bun run smithers:dev-mode` to verify the routes.

`smithers:agent-run:staged` is the first stage-level orchestration path:
`preflight → listen → generate → publish → cleanup`. It remains an operator/dev
entry point until the HTTP endpoint delegates to Smithers task execution safely;
it already shares the same cross-process run lock as `/agent/run`, and its
`publish` / `cleanup` nodes report the same per-artifact and aggregate media
evidence.

If Smithers reports a stale `running` workflow, inspect before launching more
agent work:

```sh
bun run smithers:ps
bun run smithers:why -- <run-id>
bunx smithers-orchestrator inspect <run-id>
bun run smithers:cancel -- <run-id>
```

Cancel only after the run is clearly stale/failed. A common sandbox-local case
is `agent-run-staged` failing preflight with `EPERM` on
`~/.tinycloud-agent-runs/agent-run.lock`; cancelling clears the Smithers run
record, while the Artifactory runner lock remains visible through
`GET /agent/runs`. If `cancel` exits non-zero but prints
`"status":"cancelled"`, verify with `bun run smithers:ps`.

## Runtime state — TWO separate roots, both outside the repo, dir mode `0700`

**`AGENT_STATE_DIR`** (default `~/.tinycloud-agent`) — CREDENTIALS only:

```
agent-key.json     the stable agent wallet key → did:pkh                     (0600)
api-token          the per-install API bearer token                          (0600)
delegation.json    the last-POSTed serialized delegation (restored on restart)  (0600)
tc-home/.tinycloud/...   the sandboxed delegated tc profile (profile/key/session.json all 0600)
```

**`AGENT_RUNS_DIR`** (default `~/.tinycloud-agent-runs`, or `<AGENT_STATE_DIR>-runs`
when AGENT_STATE_DIR is overridden) — RUN SCRATCH only:

```
<run_id>/status.json          per-run state for GET /agent/run/:id
<run_id>/{corpus,artifacts}/  per-run scratch — WIPED after each run (success + error)
agent-run.lock                shared active-run lock for HTTP + Smithers runners
```

All credential files are written atomically `0600` inside `0700` dirs, so the
live delegation + session key are never world-readable under a common umask.
Per-run scratch (Listen transcripts in `corpus/` + generated `artifacts/`) is
deleted after every run so the user's raw Listen data doesn't linger;
`status.json` is kept for polling.

### Credential placement (why TWO roots, both outside the repo)

The generate `claude -p` step is `--add-dir`'d onto the run's corpus + artifacts
scratch and told to Read/Write there. So the credentials must live in a
**different tree** than that scratch:

- `AGENT_STATE_DIR` holds ONLY credentials + `tc-home` → the generate step adds a
  wholesale `Read/Glob/Grep(<AGENT_STATE_DIR>/**)` deny with **no overlap** with
  any granted dir.
- `AGENT_RUNS_DIR` (separate root) holds the corpus/artifacts → these are
  `--add-dir`'d (readable/writable scratch), not under the credential deny.

The generate step also `--add-dir`s `skills/` + corpus + artifacts only (**never
`repoRoot`**), and both roots sit outside the repo so neither is reachable via
`cwd=repoRoot`. **The server validates this layout at boot** (`assertSafeLayout`
in `config.ts`): it resolves both roots to absolute paths and refuses to start —
with a clear config error — if either is nested under the other or inside the
repo (so a pathological `AGENT_RUNS_DIR=$AGENT_STATE_DIR/runs` or an in-repo
override fails fast instead of silently re-introducing the overlap).

**This closes the reported add-dir vector and removes the deny/scratch overlap,
but is not a full filesystem sandbox** — claude's Read tool in `-p` mode can open
arbitrary absolute paths and `bun -e` can read any file the process can, so real
confinement (separate uid / container / TEE) is the phase-2 (Phala) hardening.
Keep `AGENT_STATE_DIR` (credentials) out of any `--add-dir`'d path; the scratch
root is meant to be `--add-dir`'d.
