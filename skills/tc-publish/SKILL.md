# Skill: tc-publish

Publish a saved distillery artifact to the hosted TinyCloud `applications`
space (`xyz.tinycloud.artifacts`). This is the **producer's only TinyCloud
write surface** — the SQL `feed` table plus KV media. It is deterministic
plumbing: the agent does not judge anything here; the quality gate
(critic + verify-quotes) already ran upstream in the generation skill.

The contract is the greenfield artifact-pipeline contract (§1 data model, §2
media/KV, §4.3 publish). All `tc` calls go through `skills/_shared/lib/tc.ts`.

## What it does (per artifact)

1. `validateArtifact(raw)` must pass (reuses `_shared/lib/artifact.ts`).
2. `render_type = renderTypeFor(raw.type)` — the §4.2 pure mapping
   (tweet | article | video; V1 = tweet + article).
3. **Media → KV first** (non-atomicity fix): each hero/audio sibling file is
   base64-encoded and written to `xyz.tinycloud.artifacts/media/<id>/<name>.b64`,
   capturing key + sha256 + mime. Bytes land before the SQL pointer that names
   them, so a re-run repairs missing/mismatched media.
4. **SQL `feed` row**: `INSERT … ON CONFLICT(id) DO UPDATE` on the explicit
   mutable column list — never `INSERT OR REPLACE`. Immutable fields
   (`id`, `generated_at`, `raw_artifact`) are excluded from the UPDATE set.
   The full `Artifact` rides along losslessly in `raw_artifact`.
5. `approval_status = 'approved'` is written **explicitly** (no DEFAULT). Per
   the post-review decision (§9.1): V1 is feed-only, nothing is published
   externally, so there is no human gate — quality is the automated loop and
   curation is post-hoc via the interaction actions.
6. Idempotent by `id` — re-publishing upserts the same row, never a duplicate.

## Prerequisites

- `tc` (the local source build `tc-local`, js-sdk master ≥ 0.7.0-beta.2 — it has
  `kv put --space` and binary-safe base64 KV). `skills/_shared/lib/tc.ts`
  resolves it automatically; override with `TC_BIN`.
- The `applications` space hosted for the active profile, and SQL write +
  KV get/put/list caps on `xyz.tinycloud.artifacts/feed` and
  `xyz.tinycloud.artifacts/media/`. As owner, self-grant headlessly:
  ```sh
  tc auth request --cap "tinycloud.sql:applications:xyz.tinycloud.artifacts/feed:read,write" --grant --yes
  tc auth request --cap "tinycloud.kv:applications:xyz.tinycloud.artifacts/:get,put,list,metadata" --grant --yes
  ```
  As a delegate, run the §3.4 handshake (request → owner grant → import → retry).
- Profile default space set once so `--space` is optional:
  `tc profile set-default-space applications`.

## Procedure

### 1. Bootstrap the schema (idempotent — safe every run)

```sh
bun skills/tc-publish/scripts/bootstrap-schema.ts [--space applications]
```

Creates the three DBs with the EXACT §1 DDL (`artifact-schema.ts`): `artifact`
in `feed`, `interaction` in `interactions`, `distill_cursor` in `control`.
Every statement is `CREATE … IF NOT EXISTS`.

> **Known node constraint:** the node's SQLite authorizer permits
> `CREATE TABLE` but **rejects `CREATE INDEX`** ("not authorized", regardless
> of cap — a server-side constraint, not a capability gap). Bootstrap creates
> the tables and reports each rejected index **loudly** (no silent fallback).
> The indexes are query accelerators; `uq_interaction_nonce`'s replay
> protection moves to the distill layer (dedup on
> `(reader_did, nonce, recorded_at)`) until the node permits the UNIQUE index.

### 2. Publish an artifact

```sh
bun skills/tc-publish/scripts/publish.ts <artifact-dir> [--space applications] [--publisher-did DID]
```

`<artifact-dir>` is the folder a generation skill wrote
(`artifacts/<type>/<slug>/`), containing `artifact.json` plus any `hero.<ext>` /
audio sibling. The publisher DID defaults to the active profile's DID (the
`publisher_did` audit column); override for tests.

### 3. Verify the round-trip

```sh
# SQL row:
tc sql query "SELECT id, render_type, approval_status, hero_image_key FROM artifact WHERE id = ?" \
  --space applications --db xyz.tinycloud.artifacts/feed --params '["<id>"]'
# hero bytes (byte-identical to the source):
tc kv get "<hero_image_key>" --space applications --raw | base64 -d > /tmp/hero.png
```

## Error handling (no graceful fallbacks)

All branching is on the structured `error.code` from `--json`, never the exit
code (a server 401 is also exit 1):

- **`SPACE_NOT_HOSTED`** → the space is not hosted. The owner hosts it
  (`tc space host applications`); a delegate emits a host-request and BLOCKS.
  tc-publish never writes to its own primary space.
- **`AUTH_UNAUTHORIZED`** → missing cap on a now-hosted space → run the §3.3
  handshake (the error `hint` carries the exact `tc auth request --cap "…"`).

The publish then re-runs (idempotent by `id`).
