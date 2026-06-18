// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Agent Run
// smithers-description: Run the Artifactory transcript-to-feed pipeline under the persisted TinyCloud delegation.
// smithers-tags: agent, feed, tinycloud, distillery
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { config } from "../../harness/agent/src/config.ts";
import { AgentSession } from "../../harness/agent/src/session.ts";
import { runPipeline, type RunState } from "../../harness/agent/src/runner.ts";
import { createRun, writeRun } from "../../harness/agent/src/runs.ts";

const inputSchema = z.object({
  logTail: z.number().int().min(1).max(200).default(40),
});

const publishedSchema = z.object({
  type: z.string(),
  slug: z.string(),
});

const agentRunSchema = z.object({
  ok: z.boolean(),
  agentRunId: z.string(),
  status: z.enum(["queued", "running", "done", "error"]),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  published: z.array(publishedSchema),
  error: z.string().optional(),
  log: z.array(z.string()),
  statusFile: z.string(),
  notes: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  agentRun: agentRunSchema,
});

function summarize(state: RunState, logTail: number, notes: string[] = []) {
  return {
    ok: state.status === "done",
    agentRunId: state.run_id,
    status: state.status,
    startedAt: state.startedAt,
    ...(typeof state.finishedAt === "number" ? { finishedAt: state.finishedAt } : {}),
    published: state.published,
    ...(state.error ? { error: state.error } : {}),
    log: Array.isArray(state.log) ? state.log.slice(-logTail) : [],
    statusFile: `${config.runsDir}/${state.run_id}/status.json`,
    notes,
  };
}

function markError(state: RunState, err: unknown): void {
  state.status = "error";
  state.error = err instanceof Error ? err.message : String(err);
  state.finishedAt = Date.now();
  state.log.push(`${new Date().toISOString()} ERROR: ${state.error}`);
  writeRun(state);
}

export default smithers((ctx) => (
  <Workflow name="agent-run">
    <Task id="run" output={outputs.agentRun} timeoutMs={90 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
      {async () => {
        const logTail = typeof ctx.input.logTail === "number" ? ctx.input.logTail : 40;
        const state = createRun();
        const notes = [
          "This Smithers workflow reuses harness/agent/src/runner.ts so the current TinyCloud delegation and skill behavior stay identical to /agent/run.",
          "Run it only as an operator/dev entry point for now; the HTTP server still serializes its own in-process runs, and this workflow does not yet share a cross-process lock with the server.",
          "runner.ts now exports createPipelineContext plus listen-read/generate/publish stage helpers; the next migration step is wiring those helpers as separate Smithers tasks for stage-level retry/backpressure.",
        ];

        try {
          const session = await AgentSession.bootstrap();
          const active = session.getActive();
          if (!active) {
            markError(
              state,
              new Error("No active delegation found. Connect an agent from Feed or POST /agent/delegation first."),
            );
            return summarize(state, logTail, notes);
          }
          await runPipeline(active, state, writeRun);
          return summarize(state, logTail, notes);
        } catch (err) {
          markError(state, err);
          return summarize(state, logTail, notes);
        }
      }}
    </Task>
  </Workflow>
));
