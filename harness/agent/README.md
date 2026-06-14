# Distillery agent backend

A small HTTP server that holds a stable agent key (→ `did:pkh`), accepts a
user's TinyCloud **delegation**, and runs the artifact pipeline **under that
delegation** — publishing distilled artifacts to the **user's own**
`xyz.tinycloud.artifacts` space. The feed front end delegates the user's
Listen-read + artifacts-read/write scopes to this agent's DID, then hits
`/agent/run` to generate.

MVP: runs locally (`bun`). Phala/TEE deploy is phase 2 (Listen's
`agent-runtime` Docker is the deploy precedent).

## API contract

```
GET  /agent/info             → { did, name, permissions: PermissionEntry[] }            (public)
POST /agent/delegation       { serialized } → { ok, agentDid, delegationCid, spaceId, expiresAt }   (AUTH)
POST /agent/run              {} (uses the stored delegation) → { run_id, status:"queued" }           (AUTH)
GET  /agent/run/:run_id      → { run_id, status:"queued"|"running"|"done"|"error", published?:[{type,slug}], error? }
```

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

CORS is locked to a single trusted browser origin via `AGENT_ALLOWED_ORIGIN`
(e.g. `https://feed.example.com`) — **never** the `*` wildcard. The server
reflects `Access-Control-Allow-Origin` only when the request `Origin` exactly
matches. When `AGENT_ALLOWED_ORIGIN` is unset, no cross-origin request is
reflected (same-origin / curl only).

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
| `AGENT_ALLOWED_ORIGIN` | (none) | the single trusted CORS origin; no wildcard, no reflection when unset |
| `AGENT_CHAIN_ID` | `1` | EVM chain the delegation must target |
| `AGENT_MAX_DELEGATION_BYTES` | `262144` | size cap on the serialized delegation payload |
| `TINYCLOUD_HOST` | `https://node.tinycloud.xyz` | node the agent signs into + the delegation targets |
| `AGENT_STATE_DIR` | `<repo>/harness/agent/.agent-state` | all runtime state (gitignored, dir `0700`) |
| `AGENT_TC_PROFILE` | `delegated` | sandbox tc profile the delegation activates |
| `AGENT_NAME` | `Distillery Agent` | advertised in `/agent/info` |
| `AGENT_TRANSCRIPT_COUNT` | `5` | Listen transcripts pulled per run |
| `AGENT_GEN_MODEL` | `opus` | model for the headless `claude -p` generate step |
| `AGENT_GENERATE_PATH` | `~/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` | PATH for the scrubbed-env generate child (needs `bun` + `claude`) |
| `NODE_SDK_DIST` | (built js-sdk checkout) | override the `@tinycloud/node-sdk` dist path |

The generate step spawns `claude -p`, so `claude` must be on PATH (and logged
in). An optional Gemini key (`GOOGLE_AI_API_KEY` / `GEMINI_API_KEY` /
`GOOGLE_API_KEY`) lets the article get an illustrated hero; without one the
generation agent uses a local image.

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
   WebFetch/WebSearch, and `--no-session-persistence` keeps the untrusted
   transcript out of `~/.claude` history. `$HOME` stays the **real** home —
   claude's login token lives in the macOS Keychain, bound to the real `$HOME`, so
   a minimal HOME makes `claude -p` report "Not logged in". **Caveat:** `bun` is
   required and turing-complete (`bun -e <js>`), so the tool denylist raises the
   bar but is NOT a sandbox — a prompt-injected read could still reach
   `~/.tinycloud` on disk. Full process/filesystem isolation is the **phase-2
   (Phala/TEE)** hardening. The other stages get the sandbox HOME.

## The pipeline (`POST /agent/run`)

`bootstrap → listen-read → generate → critic → publish`, all under the
delegation, into a per-run scratch dir (`<AGENT_STATE_DIR>/runs/<id>/`):

1. **listen-read** — `tc-listen-read/listen-read.ts` pulls the user's Listen
   transcripts into the run's corpus. **Empty-Listen-safe:** 0 transcripts →
   the run completes with 0 artifacts (valid), skipping generate + publish.
2. **generate** — headless `claude -p` distills one tweet (banger-extractor) and
   one article (write-article + hero) into the run's artifacts dir, with an
   adversarial critic + verify-quotes gate (no human approval, per §9).
3. **publish** — `tc-publish/publish.ts` upserts each survivor to the user's
   `xyz.tinycloud.artifacts` (KV media + SQL feed row, `approval_status='approved'`).

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

The Smithers form of this flow is authored at
`.smithers/workflows/agent-run.tsx` (phase-2 target). It is **not yet runnable**
via `smithers up` on this branch: the local `.smithers` orchestrator pins
`smithers-orchestrator ^0.20.4` while the global CLI is `0.22.0` (a React-version
skew that blocks `graph`/`run`). Until the versions align, `/agent/run` runs the
same stages directly (`runner.ts`).

## Runtime state (gitignored: `/harness/agent/.agent-state/`, dir mode `0700`)

```
agent-key.json              the stable agent wallet key → did:pkh           (0600)
api-token                   the per-install API bearer token                (0600)
delegation.json             the last-POSTed serialized delegation (restored on restart)  (0600)
runs/<run_id>/status.json   per-run state for GET /agent/run/:id
runs/<run_id>/{corpus,artifacts}/   per-run scratch — WIPED after each run (success + error)
tc-home/.tinycloud/...      the sandboxed delegated tc profile (profile/key/session.json all 0600)
```

All credential files are written atomically `0600` inside `0700` dirs, so the
live delegation + session key are never world-readable under a common umask.
Per-run scratch (Listen transcripts in `corpus/` + generated `artifacts/`) is
deleted after every run so the user's raw Listen data doesn't linger;
`status.json` is kept for polling.
