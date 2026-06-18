# Smithers Workflows

This repo uses a local Smithers workflow pack for durable development work,
triage, backpressure planning, and run monitoring.

Useful commands:

```sh
bun run smithers:doctor
bun run smithers:list
bun run smithers:dev-mode
bun run smithers:agent-run
bun run smithers:agent-run:staged
```

`feed-dev-mode` probes the current local development setup:

- Feed served over Portless at `https://feed.localhost:1355`
- Local Artifactory agent at `https://agent.feed.localhost:1355`
- Local Gemini development env, sourced from `DEV_DISTILLERY_ENV` or
  `~/development.nosync/distillery/.env`
- Portless route/listener evidence plus endpoint fetches. Endpoint checks can
  report `blocked` when a restricted agent sandbox cannot connect to localhost;
  in that case rerun the workflow outside the sandbox before treating Portless
  as broken.

Start the two surfaces with:

```sh
cd ../feed && PORTLESS_PORT=1355 bun run dev
cd ../artifactory && AGENT_API_TOKEN=local-claude-dev PORTLESS_PORT=1355 bun run artifact:agent:dev:https
```

`agent-run` is the first workflow bridge for the real transcript-to-artifact
pipeline. It reuses `harness/agent/src/runner.ts` and the persisted TinyCloud
delegation, so it executes the same skill chain as `/agent/run`:
`tc-listen-read → generate via SKILL.md instructions → media preflight →
tc-publish`. It writes the usual `<AGENT_RUNS_DIR>/<run_id>/status.json` and
returns a bounded log tail in the Smithers output.

For now, treat `agent-run` as an operator/dev command, not the production HTTP
control path. The HTTP server still serializes its own in-process runs, and this
workflow does not yet share a cross-process run lock with the server. The next
orchestration migration is to wire the exported runner stage helpers
(`createPipelineContext`, `runListenReadStage`, `runGenerateStage`,
`runPublishStage`) as separate Smithers tasks so each stage has independent
retry, observability, and backpressure.

`agent-run-staged` is that first stage-level workflow. It is still an
operator/dev entry point, but it breaks a run into Smithers nodes:
`preflight → listen → generate → publish → cleanup`. It uses the same runner
helpers as `/agent/run`, so behavior stays aligned while Smithers gains
stage-level logs and retry/replay boundaries. A cold graph initially shows only
`preflight`; downstream nodes are rendered as prior task outputs exist.

The generated Smithers pack intentionally keeps secrets out of git. Local API
keys are a development bridge only; the target home is TinyCloud Secret Manager.
