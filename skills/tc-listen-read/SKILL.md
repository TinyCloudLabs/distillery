# Skill: tc-listen-read

Read curated Listen conversations + transcripts from TinyCloud and write them
as diarized markdown into a local corpus dir the distillery generation skills
consume (they take transcript paths at invocation). This is the **fetch** node
of the artifact pipeline. Deterministic plumbing only — no model calls.

The contract is §3.4 of the greenfield artifact-pipeline contract
(delegate-asks-owner; file hand-off, no server poll).

## Where Listen data lives

Listen is a TinyCloud manifest app (`app_id: xyz.tinycloud.listen`). Its
canonical data lives in the **owner's `applications` space**:

- **Conversations (SQL):** `--db xyz.tinycloud.listen/conversations` → tables
  `conversation`, `participant`.
- **Transcripts (KV):** `xyz.tinycloud.listen/transcript/<conversationId>` → a
  JSON array of `{ index, speaker_id, speaker_name, text, start_time, … }`.

## Prerequisites

- `tc` (local source build; `skills/_shared/lib/tc.ts` resolves it, `TC_BIN`
  overrides).
- Read caps on the Listen owner's `applications` space:
  - `tinycloud.sql:<owner-space>:xyz.tinycloud.listen/conversations:read`
  - `tinycloud.kv:<owner-space>:xyz.tinycloud.listen/:get,list,metadata`
  (KV prefix caps need a **trailing slash**; KV actions are `get,list,metadata`,
  NOT `read`.)

## Procedure

```sh
bun skills/tc-listen-read/scripts/listen-read.ts --out <corpus-dir> [--count 5] [--space <owner-space>]
```

`--space` defaults to the profile's configured default space. To read a Listen
space owned by a **different** identity, pass the owner's space URI
(`tinycloud:pkh:eip155:1:<owner-addr>:applications`) and hold a delegation for
it. Writes one markdown file per non-empty transcript and lists what it wrote.

### Emit the delegation request the owner grants (one command)

When the Listen owner is a different identity (e.g. the OpenKey `default`
profile that owns the canonical Listen data), emit the exact request artifact —
**one file carrying BOTH caps** (`--cap` is repeatable) — so the owner's grant
is a single command:

```sh
bun skills/tc-listen-read/scripts/listen-read.ts \
  --emit-request ./listen-read-request.json \
  --owner-space tinycloud:pkh:eip155:1:<owner-addr>:applications
```

This prints the owner-grant + import + retry handshake. A normal `--out` read
that 401s **auto-emits the same request** when `--owner-space` is passed — so
the moment the owner runs their (browser) grant, the agent ingests immediately
by re-running the read.

## Access remediation (§3.4 — no fabricated data)

Branch on the structured `error.code`:

- **`AUTH_UNAUTHORIZED`** — missing the read cap.
  - **You are the owner** (local-key): self-grant headlessly:
    ```sh
    tc auth request --cap "<cap from error.hint>" --grant --yes
    ```
  - **You are a delegate** — the file hand-off handshake (the run BLOCKS here;
    durable Smithers state parks it until access lands, then re-run). The skill
    auto-emits step 1's request when `--owner-space` is known:
    ```sh
    # 1. agent (or auto-emitted on a 401 with --owner-space):
    bun skills/tc-listen-read/scripts/listen-read.ts --emit-request ./listen-read-request.json --owner-space <owner-space-uri>
    # 2. owner (send them the file; OpenKey owners do this in a browser):
    tc auth grant ./listen-read-request.json --yes > ./listen-read-grant.json
    # 3. agent:
    tc auth import ./listen-read-grant.json
    # 4. agent: wait for "covered": true, then re-run the read:
    tc auth retry --last
    ```
- **`SPACE_NOT_HOSTED`** — the Listen space is not hosted. Only its owner can
  host it (`tc space host <name>`); a delegate emits
  `tc space host-request <name> --emit ./host-request.json` and BLOCKS.

> **OpenKey owners need a browser.** If the Listen owner is an `owner-openkey`
> profile (e.g. the `default` profile that owns the canonical Listen data),
> `tc auth request --grant` launches a browser flow — it cannot complete
> headlessly. The owner must complete that grant (or grant a local-key delegate)
> out-of-band; then this skill reads via the delegation.

## Anti-filter-bubble note

The fetch node should pull a recency-weighted pool **plus one
preference-AGNOSTIC deep-dive** (§5) — the deep-dive is the reserve that keeps
the feed from collapsing into what preferences already favor. This skill is the
mechanism; the selection policy lives in the workflow that calls it.
