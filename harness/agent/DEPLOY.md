# Deploying the distillery agent backend to a Phala CVM (TEE)

Deploys `harness/agent` to a Phala Cloud Confidential VM (Intel TDX). The agent
holds a stable `did:pkh`, accepts a user delegation, and runs the artifact
pipeline under it — see `README.md` for the app itself.

## Live today

The agent backend is **deployed and serving** on a Phala CVM:

| | |
|---|---|
| CVM id | `f606e95d-2717-40e8-bf6a-68031d86a089` (`tdx.small`) |
| Public URL | `https://ad9fd8859b5777e84c79e25721b423b85ee3e20a-4097.dstack-pha-prod5.phala.network` |
| Agent DID | `did:pkh:eip155:1:0x95d17f5248dCbf90E8257eDfFd4a458efE276F60` (stable on the named volume) |
| Image | `ghcr.io/tinycloudlabs/distillery-agent:b581bd8` — **public** (anon pull, no pull creds) |
| Origins (CORS) | `https://tinyfeed.pages.dev`, `https://tinyfeed.tinycloud.xyz` |

It serves the live [TinyFeed](https://tinyfeed.pages.dev) front end, which
delegates each user's scopes to this DID and triggers runs under that delegation.
Because the image is public, the deploy carries **no `DSTACK_DOCKER_*` creds**.

To update it, edit `agent.env` and redeploy to the **same** CVM (preserving the
volume → the same DID):

```sh
phala deploy --cvm-id f606e95d-2717-40e8-bf6a-68031d86a089 \
  -c harness/agent/docker-compose.yml \
  -e harness/agent/agent.env
```

The sections below are the from-scratch runbook (e.g. a fresh CVM).

## What the container provides (and why)

Locally the agent resolves three things from the host (a source-built `tc`, a
Homebrew `claude`, the macOS Keychain). NONE exist in a Linux TEE, so the image
(`Dockerfile`):

- installs the **published** npm tools — `@tinycloud/cli@0.7.0-beta.4` (verified:
  supports `kv put --space`), `@tinycloud/node-sdk@2.4.0-beta.2` (pure-WASM,
  exports every symbol `session.ts` imports), `@anthropic-ai/claude-code` — and
  overrides the two **hardcoded macOS paths** in the committed source via env:
  `TC_BIN` and `NODE_SDK_DIST`.
- feeds claude auth from an **env secret** (`ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN`) — there is no Keychain in the TEE.
- binds `0.0.0.0` and persists `AGENT_STATE_DIR` on a **named volume** so the
  `did:pkh` is stable across restarts.

## 1. Build (amd64 — Phala is Intel TDX only)

On Apple Silicon you MUST cross-build, or the CVM crashes with `exec format error`:

```sh
# from the distillery repo root (the build context)
docker buildx build --platform linux/amd64 \
  -f harness/agent/Dockerfile \
  -t ghcr.io/tinycloudlabs/distillery-agent:<tag> \
  --load .
```

Smoke-test it locally before pushing:

```sh
docker run -d --name agent-smoke -p 4097:4097 \
  -e AGENT_API_TOKEN=smoke ghcr.io/tinycloudlabs/distillery-agent:<tag>
curl -fsS http://127.0.0.1:4097/agent/info   # → { did, name, permissions[] }
docker rm -f agent-smoke
```

## 2. Push to a registry (the CVM pulls by tag)

The compose references `image:` — the CVM has no build context. Push to a
registry the CVM can pull from:

```sh
docker push ghcr.io/tinycloudlabs/distillery-agent:<tag>
```

The live image is **public** (`ghcr.io/tinycloudlabs/distillery-agent`), so the
CVM pulls it anonymously and the deploy needs **no pull creds** — this is the
recommended posture (the image carries no secrets; everything is injected at
runtime). Make a new GHCR package public in the package settings UI (GitHub has
no REST API for container-package visibility).

> **Private-repo fallback (avoid if you can):** if the image must stay private,
> add pull creds to `agent.env`: `DSTACK_DOCKER_USERNAME` + `DSTACK_DOCKER_PASSWORD`
> **and `DSTACK_DOCKER_REGISTRY=ghcr.io`** — without the registry override the
> dstack pre-launch login defaults to `docker.io` and the GHCR pull fails
> `unauthorized` (verified). Use a **dedicated `read:packages`-only token** as the
> password — never a broad `gh auth token` (it would put repo/workflow scopes in
> the TEE secret store).

## 3. Secrets env file

```sh
cp harness/agent/agent.env.example harness/agent/agent.env
# fill: AGENT_API_TOKEN, ONE of ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN,
#       AGENT_ALLOWED_ORIGIN (the deployed feed origin), AGENT_IMAGE=<the pushed tag>
```

`agent.env` is gitignored. `phala deploy -e` encrypts it **client-side** before
transmission — values never touch the plaintext compose.

## 4. Deploy

```sh
phala deploy \
  -c harness/agent/docker-compose.yml \
  -n distillery-agent \
  -e harness/agent/agent.env \
  -t tdx.small \
  --wait
```

`phala cvms list` shows the CVM id + state; the public URL is on the CVM detail
(`phala cvms get <id>`). Logs: `phala logs <id>` (add `--serial` if it won't
boot — an amd64/exec-format issue shows there).

## 5. Wire the feed

The feed (TinyFeed) reads the agent **host + DID at runtime** from a served
`agent-config.json`, so repointing it needs **no rebuild**:

- `web/public/agent-config.json` → `{ "host": "<CVM public URL>", "did": "<the did from GET /agent/info>" }`.
  Editing this file + redeploying the static site repoints the feed; the `did`
  is also auto-discovered from `GET <host>/agent/info` if omitted.
- `VITE_AGENT_TOKEN` (the **only** build-time var) → the `AGENT_API_TOKEN` you set
  in `agent.env`. Set it once on the Cloudflare Pages project.

(The bearer token ships in the client bundle — it's a casual-access gate, not a
secret; the real protection is that the agent only acts under the user's signed
delegation and writes only to that user's own space.)

## Stable DID across restarts

`AGENT_STATE_DIR` (the agent key → `did:pkh`) lives on the `agent-state` named
volume, so restarts/updates keep the DID. **First deploy mints a fresh DID** —
read it from `GET /agent/info` after boot and set `VITE_AGENT_DID`. Destroying
the volume (or the CVM) mints a new one; to keep a DID across a full teardown,
seed the key as a secret instead (not done here).
