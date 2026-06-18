// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Agent Run Staged
// smithers-description: Run the Artifactory transcript-to-feed pipeline as separate Smithers stages.
// smithers-tags: agent, feed, tinycloud, distillery, observability
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { config } from "../../harness/agent/src/config.ts";
import { AgentSession, type ActiveDelegation } from "../../harness/agent/src/session.ts";
import {
  cleanupRunScratch,
  createPipelineContext,
  prepareRunScratch,
  runGenerateStage,
  runListenReadStage,
  runPublishStage,
  type RunState,
} from "../../harness/agent/src/runner.ts";
import { createRun, readRun, writeRun } from "../../harness/agent/src/runs.ts";

const inputSchema = z.object({
  logTail: z.number().int().min(1).max(200).default(40),
});

const publishedSchema = z.object({
  type: z.string(),
  slug: z.string(),
});

const runStatusSchema = z.enum(["queued", "running", "done", "error"]);

const stageBaseSchema = z.object({
  ok: z.boolean(),
  agentRunId: z.string(),
  stage: z.string(),
  status: runStatusSchema,
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  statusFile: z.string(),
  error: z.string().optional(),
  log: z.array(z.string()),
});

const preflightSchema = stageBaseSchema.extend({
  hasDelegation: z.boolean(),
  notes: z.array(z.string()),
});

const listenSchema = stageBaseSchema.extend({
  listenStatus: z.enum(["ready", "empty", "error"]),
  transcriptCount: z.number().int().nonnegative(),
  transcripts: z.array(z.string()),
});

const generateSchema = stageBaseSchema.extend({
  skipped: z.boolean(),
  transcriptCount: z.number().int().nonnegative(),
});

const publishSchema = stageBaseSchema.extend({
  skipped: z.boolean(),
  published: z.array(publishedSchema),
});

const cleanupSchema = stageBaseSchema.extend({
  cleaned: z.boolean(),
  published: z.array(publishedSchema),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  preflight: preflightSchema,
  listen: listenSchema,
  generate: generateSchema,
  publish: publishSchema,
  cleanup: cleanupSchema,
});

function statusFile(runId: string): string {
  return `${config.runsDir}/${runId}/status.json`;
}

function logTail(state: RunState, max: number): string[] {
  return Array.isArray(state.log) ? state.log.slice(-max) : [];
}

function base(stage: string, state: RunState, logTailMax: number, ok: boolean) {
  return {
    ok,
    agentRunId: state.run_id,
    stage,
    status: state.status,
    startedAt: state.startedAt,
    ...(typeof state.finishedAt === "number" ? { finishedAt: state.finishedAt } : {}),
    statusFile: statusFile(state.run_id),
    ...(state.error ? { error: state.error } : {}),
    log: logTail(state, logTailMax),
  };
}

function markError(state: RunState, err: unknown): RunState {
  state.status = "error";
  state.error = err instanceof Error ? err.message : String(err);
  state.finishedAt = Date.now();
  state.log.push(`${new Date().toISOString()} ERROR: ${state.error}`);
  writeRun(state);
  return state;
}

function missingRunState(runId: string): RunState {
  return {
    run_id: runId,
    status: "running",
    published: [],
    startedAt: Date.now(),
    log: [],
  };
}

async function restoreContext(agentRunId: string): Promise<{
  active: ActiveDelegation;
  state: RunState;
  ctx: ReturnType<typeof createPipelineContext>;
}> {
  const state = readRun(agentRunId);
  if (!state) throw new Error(`Unknown agent run ${agentRunId}`);

  const session = await AgentSession.bootstrap();
  const active = session.getActive();
  if (!active) {
    throw new Error("No active delegation found. Connect an agent from Feed or POST /agent/delegation first.");
  }

  return {
    active,
    state,
    ctx: createPipelineContext(active, state, writeRun),
  };
}

export default smithers((ctx) => {
  const logTailMax = typeof ctx.input.logTail === "number" ? ctx.input.logTail : 40;
  const preflight = ctx.outputMaybe("preflight", { nodeId: "preflight" });
  const listen = ctx.outputMaybe("listen", { nodeId: "listen" });
  const generate = ctx.outputMaybe("generate", { nodeId: "generate" });
  const publish = ctx.outputMaybe("publish", { nodeId: "publish" });

  const shouldListen = preflight?.ok === true;
  const shouldGenerate = listen?.ok === true && listen.listenStatus === "ready";
  const shouldPublish = generate?.ok === true && generate.skipped === false;
  const terminal =
    preflight !== undefined &&
    (preflight.ok === false ||
      listen?.listenStatus === "empty" ||
      listen?.listenStatus === "error" ||
      generate?.ok === false ||
      publish !== undefined);

  return (
    <Workflow name="agent-run-staged">
      <Sequence>
        <Task id="preflight" output={outputs.preflight}>
          {async () => {
            const state = createRun();
            const notes = [
              "This staged workflow runs the same runner helpers as /agent/run, but exposes Smithers nodes for preflight, listen, generate, publish, and cleanup.",
              "Operator/dev entry point only for now: the HTTP server still owns production /agent/run and has its own in-process serialization.",
            ];
            try {
              const session = await AgentSession.bootstrap();
              const active = session.getActive();
              if (!active) {
                markError(
                  state,
                  new Error("No active delegation found. Connect an agent from Feed or POST /agent/delegation first."),
                );
                return { ...base("preflight", state, logTailMax, false), hasDelegation: false, notes };
              }
              const pipe = createPipelineContext(active, state, writeRun);
              state.status = "running";
              pipe.step("run started");
              await prepareRunScratch(pipe);
              return { ...base("preflight", state, logTailMax, true), hasDelegation: true, notes };
            } catch (err) {
              markError(state, err);
              return { ...base("preflight", state, logTailMax, false), hasDelegation: false, notes };
            }
          }}
        </Task>

        {shouldListen ? (
          <Task id="listen" output={outputs.listen}>
            {async () => {
              const runId = preflight.agentRunId;
              let state = readRun(runId);
              try {
                const restored = await restoreContext(runId);
                state = restored.state;
                const result = await runListenReadStage(restored.ctx);
                if (result.kind === "empty") {
                  return {
                    ...base("listen", state, logTailMax, true),
                    listenStatus: "empty" as const,
                    transcriptCount: 0,
                    transcripts: [],
                  };
                }
                return {
                  ...base("listen", state, logTailMax, true),
                  listenStatus: "ready" as const,
                  transcriptCount: result.transcripts.length,
                  transcripts: result.transcripts,
                };
              } catch (err) {
                state = markError(state ?? missingRunState(runId), err);
                return {
                  ...base("listen", state, logTailMax, false),
                  listenStatus: "error" as const,
                  transcriptCount: 0,
                  transcripts: [],
                };
              }
            }}
          </Task>
        ) : null}

        {shouldGenerate ? (
          <Task id="generate" output={outputs.generate} timeoutMs={90 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
            {async () => {
              const runId = listen.agentRunId;
              let state = readRun(runId);
              try {
                const restored = await restoreContext(runId);
                state = restored.state;
                await runGenerateStage(restored.ctx, listen.transcripts);
                return {
                  ...base("generate", state, logTailMax, true),
                  skipped: false,
                  transcriptCount: listen.transcriptCount,
                };
              } catch (err) {
                state = markError(state ?? missingRunState(runId), err);
                return {
                  ...base("generate", state, logTailMax, false),
                  skipped: false,
                  transcriptCount: listen.transcriptCount,
                };
              }
            }}
          </Task>
        ) : null}

        {shouldPublish ? (
          <Task id="publish" output={outputs.publish}>
            {async () => {
              const runId = generate.agentRunId;
              let state = readRun(runId);
              try {
                const restored = await restoreContext(runId);
                state = restored.state;
                await runPublishStage(restored.ctx);
                state.status = "done";
                state.finishedAt = Date.now();
                writeRun(state);
                return { ...base("publish", state, logTailMax, true), skipped: false, published: state.published };
              } catch (err) {
                state = markError(state ?? missingRunState(runId), err);
                return { ...base("publish", state, logTailMax, false), skipped: false, published: state.published };
              }
            }}
          </Task>
        ) : null}

        {terminal ? (
          <Task id="cleanup" output={outputs.cleanup}>
            {async () => {
              const runId =
                publish?.agentRunId ??
                generate?.agentRunId ??
                listen?.agentRunId ??
                preflight.agentRunId;
              const state = readRun(runId);
              if (!state) {
                throw new Error(`Unknown agent run ${runId}`);
              }
              await cleanupRunScratch(runId);
              return { ...base("cleanup", state, logTailMax, state.status !== "error"), cleaned: true, published: state.published };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
