# harness/ops/launchd — the distillery heartbeat + durability (spec §7)

Three legacy launchd agents made the original local Distillery/Folio feed
self-running on Hunter's Mac. They are retained for historical installs and
migration reference, but they are not the active Artifactory/Feed development
path. New local development should use `bun run artifact:dev:https`, which
serves `submodules/feed` plus `harness/agent` through Portless.

| plist | what | KeepAlive? |
|---|---|---|
| `com.tinycloud.distillery.feedrun` | weekday-morning (Mon–Fri 07:00) headless feed-run | no — scheduled one-shot |
| `com.tinycloud.distillery.server` | legacy Folio feed server (`bun src/server.ts` in `harness/feed/`, after `bun run build`) | **yes** — survives reboot |
| `com.tinycloud.distillery.tunnel` | the cloudflared named tunnel `distillery` → `localhost:4242` | **yes** — survives reboot |

Nothing here is loaded automatically. Before loading or keeping these jobs,
confirm you actually want the old repo-local Folio feed path rather than the
current TinyCloud-backed Feed/agent combo. The install script **templates +
stages + validates** the plists; **you** run the `launchctl` commands (they
touch your login session).

## Files

```
feedrun.sh              wrapper: PATH + TRANSCRIPT_DIRS + .env → claude -p (recipe)
                        or, with FEEDRUN_DRY_RUN=1, feed-run.ts --no-generate (preview)
server.sh               wrapper: server.env → bun run build → bun src/server.ts
feedrun.env.example     copy → feedrun.env (gitignored): PATH + TRANSCRIPT_DIRS
server.env.example      copy → server.env  (gitignored): PATH + OPENKEY allowlist
feedrun.system.md       (optional) override the headless system prompt
com.tinycloud.distillery.{feedrun,server,tunnel}.plist   templated agents
install-launchd.sh      fill __REPO__/__HOME__/__CLOUDFLARED__ → ~/Library/LaunchAgents
logs/                   StandardOut/Err for all three (gitignored)
```

## Install

```bash
# 1. Stage the plists (fills placeholders, validates with plutil, NO load):
bash harness/ops/launchd/install-launchd.sh

# 2. Fill the env files (once):
cp harness/ops/launchd/feedrun.env.example harness/ops/launchd/feedrun.env
cp harness/ops/launchd/server.env.example  harness/ops/launchd/server.env
#   feedrun.env: set PATH (must reach `claude` + `bun`) and TRANSCRIPT_DIRS
#                (comma-separated absolute corpus dirs — the three vault folders)
#   server.env:  set PATH and OPENKEY_ALLOWED_ADDRESSES (your OpenKey address)
#   .env:        ensure the Gemini key is present (GOOGLE_AI_API_KEY=...) — TTS +
#                image steps need it; index/query/distill don't

# 3. Load each agent into your GUI session:
UID_=$(id -u)
launchctl bootstrap gui/$UID_ ~/Library/LaunchAgents/com.tinycloud.distillery.server.plist
launchctl bootstrap gui/$UID_ ~/Library/LaunchAgents/com.tinycloud.distillery.tunnel.plist
launchctl bootstrap gui/$UID_ ~/Library/LaunchAgents/com.tinycloud.distillery.feedrun.plist
```

### Set the transcript dirs + allowlist

- **TRANSCRIPT_DIRS** (in `feedrun.env`, and `server.env` for the button): the
  three real vault folders under
  `/Users/hunterhorsfall/Obsidian Vaults/TinyCloud 2025/Team Relays/TinyCloud Team Space/`
  — `Fireflies-Transcripts`, `Gemini-Transcripts`, `Soundcore-Transcripts`,
  comma-separated, absolute. Nothing is hardcoded in any skill.
- **OPENKEY_ALLOWED_ADDRESSES** (in `server.env`): your OpenKey address. This
  gates `/api/*` and `/media/*` — including `POST /api/generate`, the
  highest-privilege route (it spends Gemini money + publishes to the live feed).

## Inspect / run-now / uninstall

```bash
UID_=$(id -u)

# Status of an agent:
launchctl print gui/$UID_/com.tinycloud.distillery.server

# Force a feed-run NOW (don't wait for 7am) — this is also how you force a run
# without the Generate button:
launchctl kickstart -k gui/$UID_/com.tinycloud.distillery.feedrun

# Uninstall (per agent):
launchctl bootout gui/$UID_/com.tinycloud.distillery.feedrun
launchctl bootout gui/$UID_/com.tinycloud.distillery.server
launchctl bootout gui/$UID_/com.tinycloud.distillery.tunnel
```

## Logs

All three agents log to `harness/ops/launchd/logs/` (gitignored):

```
logs/feedrun.out.log  logs/feedrun.err.log   # [feedrun] wrapper + claude -p output
logs/server.out.log   logs/server.err.log    # feed server startup + requests
logs/tunnel.out.log   logs/tunnel.err.log    # cloudflared
```

The feed-run also writes a structured per-run record under `index/runs/<ts>/`
and appends a one-liner to `index/run-log.jsonl` (the Generate button polls
this) — see spec §7.

## Concurrency (spec §10 R1)

`feedrun.sh` holds a PID lockfile at `index/.run.lock`. A second run (overlapping
cron, or the Generate button while a cron run is live) aborts early with exit 75;
`POST /api/generate` maps that to HTTP 409. A stale lock (dead PID) is reclaimed
automatically.

## The tunnel

The `distillery` tunnel (`64a191a4-9537-413f-83fc-ab1f374774de`) is already
created; its config lives at `~/.cloudflared/distillery.yml`
(`distillery.tinytunnel.xyz` → `http://localhost:4242`). The plist just runs it
under KeepAlive. If you ever rotate the tunnel, update that yml — the plist reads
it by path.
