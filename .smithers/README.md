# Smithers Workflows

This repo uses a local Smithers workflow pack for durable development work,
triage, backpressure planning, and run monitoring.

Useful commands:

```sh
bun run smithers:doctor
bun run smithers:list
bun run smithers:ps
bun run smithers:dev-mode
bun run smithers:agent-run
bun run smithers:agent-run:staged
```

`feed-dev-mode` probes the current local development setup:

- Feed served over Portless at `https://feed.localhost:1355`
- Local Artifactory agent at `https://agent.feed.localhost:1355`
- Local Gemini development env, sourced from `DEV_DISTILLERY_ENV` or
  `~/development.nosync/distillery/.env`
- Embedded Feed submodule alignment against the sibling `../feed` checkout.
  This is a readiness check because Smithers dev mode serves `../feed`, while
  Artifactory package scripts serve `submodules/feed`.
- Portless route/listener evidence plus endpoint fetches. Endpoint checks can
  report `blocked` when a restricted agent sandbox cannot connect to localhost;
  in that case rerun the workflow outside the sandbox before treating Portless
  as broken.
- Portless state writability for `~/.portless` and `~/.portless/proxy.log`.
  If the launcher fails with `EPERM: operation not permitted, open
  '/Users/.../.portless/proxy.log'`, the current sandbox cannot start the
  Portless proxy. Run the launcher outside the sandbox or approve the
  unsandboxed dev-server command.

Start the two surfaces with:

```sh
PORTLESS_PORT=1355 bun run artifact:dev:https
```

That command starts the embedded Feed submodule and the local Artifactory agent
behind Portless, sets `VITE_AGENT_CONFIG_OVERRIDE=1`, points Feed at
`https://agent.feed.localhost:1355`, and shares one local bearer token between
the browser bundle and agent backend. For split-terminal debugging, run the two
commands separately:

```sh
cd submodules/feed && PORTLESS_PORT=1355 VITE_AGENT_CONFIG_OVERRIDE=1 VITE_AGENT_HOST=https://agent.feed.localhost:1355 VITE_AGENT_TOKEN=local-claude-dev bun run dev
AGENT_API_TOKEN=local-claude-dev PORTLESS_PORT=1355 bun run artifact:agent:dev:https
```

`agent-run` is the first workflow bridge for the real transcript-to-artifact
pipeline. It reuses `harness/agent/src/runner.ts` and the persisted TinyCloud
delegation, so it executes the same skill chain as `/agent/run`:
`tc-listen-read → generate via SKILL.md instructions → media preflight →
tc-publish`. It writes the usual `<AGENT_RUNS_DIR>/<run_id>/status.json` and
returns a bounded log tail in the Smithers output.

For now, treat `agent-run` as an operator/dev command, not the production HTTP
control path. The HTTP server and Smithers workflows now share a disk-backed
run lock in `AGENT_RUNS_DIR`, so only one delegated pipeline can use the mutable
tc profile at a time across processes. The next orchestration migration is to
wire the exported runner stage helpers (`createPipelineContext`,
`runListenReadStage`, `runGenerateStage`, `runPublishStage`) as separate
Smithers tasks so each stage has independent retry, observability, and
backpressure.

`agent-run-staged` is that first stage-level workflow. It is still an
operator/dev entry point, but it breaks a run into Smithers nodes:
`preflight → listen → generate → publish → cleanup`. It uses the same runner
helpers as `/agent/run`, so behavior stays aligned while Smithers gains
stage-level logs and retry/replay boundaries. A cold graph initially shows only
`preflight`; downstream nodes are rendered as prior task outputs exist.

The generated Smithers pack intentionally keeps secrets out of git. Local API
keys are a development bridge only; the target home is TinyCloud Secret Manager.

## Stale run triage

Smithers can leave a run with `dbStatus: running` after a sandbox or process
interruption. Treat this as operator backpressure: inspect before starting more
agent work.

```sh
bun run smithers:ps
bun run smithers:why -- <run-id>
bunx smithers-orchestrator inspect <run-id>
bun run smithers:cancel -- <run-id>
```

Cancel only after `why`/`inspect` show the run is stale, failed, or no longer
has active work to preserve. A common local-dev case is a stale
`agent-run-staged` preflight blocked by sandbox permissions on
`~/.tinycloud-agent-runs/agent-run.lock`; cancelling clears Smithers' local run
table, while the Artifactory runner lock remains governed separately by
`GET /agent/runs`. If `cancel` exits non-zero but prints
`"status":"cancelled"`, verify with `bun run smithers:ps`.
