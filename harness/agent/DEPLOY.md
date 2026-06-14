# Deploying the distillery agent backend to a Phala CVM (TEE)

Phase-2 deploy of `harness/agent` to a Phala Cloud Confidential VM (Intel TDX).
The agent holds a stable `did:pkh`, accepts a user delegation, and runs the
artifact pipeline under it — see `README.md` for the app itself.

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
  -t docker.io/<namespace>/distillery-agent:<tag> \
  --load .
```

Smoke-test it locally before pushing:

```sh
docker run -d --name agent-smoke -p 4097:4097 \
  -e AGENT_API_TOKEN=smoke docker.io/<namespace>/distillery-agent:<tag>
curl -fsS http://127.0.0.1:4097/agent/info   # → { did, name, permissions[] }
docker rm -f agent-smoke
```

## 2. Push to a registry (the CVM pulls by tag)

The compose references `image:` — the CVM has no build context. Push to a
registry the CVM can pull from:

```sh
docker push docker.io/<namespace>/distillery-agent:<tag>
```

For a **private** repo, add the pull creds to `agent.env` (encrypted by the
deploy, never in compose): `DSTACK_DOCKER_USERNAME` + `DSTACK_DOCKER_PASSWORD`,
**and `DSTACK_DOCKER_REGISTRY=ghcr.io`** — without the registry override the
dstack pre-launch login defaults to `docker.io` and the GHCR pull fails
`unauthorized` (verified). The password is a token with `read:packages` (a
`gh auth token` works).

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

Point the feed at the deployed CVM:

- `VITE_AGENT_HOST` → the CVM's public URL (the `:4097` ingress).
- `VITE_AGENT_DID`  → the `did` from `GET <host>/agent/info` (the stable key on
  the volume — see below).
- `VITE_AGENT_TOKEN` → the `AGENT_API_TOKEN` you set in `agent.env`.

## Stable DID across restarts

`AGENT_STATE_DIR` (the agent key → `did:pkh`) lives on the `agent-state` named
volume, so restarts/updates keep the DID. **First deploy mints a fresh DID** —
read it from `GET /agent/info` after boot and set `VITE_AGENT_DID`. Destroying
the volume (or the CVM) mints a new one; to keep a DID across a full teardown,
seed the key as a secret instead (not done here).
