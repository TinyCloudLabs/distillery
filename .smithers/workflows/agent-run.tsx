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
import { verifyAgentRunProof } from "../../harness/agent/src/run-proof.ts";
import { ARTIFACT_TYPES, type ArtifactType } from "../../skills/_shared/lib/formats.ts";
import {
  acquireRunLock,
  createRun,
  createRunId,
  releaseRunLock,
  summarizePublishedMedia,
  writeRun,
} from "../../harness/agent/src/runs.ts";

const artifactTargetValues = ["auto", ...ARTIFACT_TYPES] as const;

const inputSchema = z.object({
  logTail: z.number().int().min(1).max(200).default(40),
  artifactType: z.enum(artifactTargetValues).default("auto"),
});

const publishedSchema = z.object({
  type: z.string(),
  slug: z.string(),
  media: z
    .object({
      heroImage: z.boolean(),
      audio: z.boolean(),
      video: z.boolean(),
    })
    .optional(),
});

const heldSchema = z.object({
  type: z.string(),
  slug: z.string(),
  reason: z.string(),
});

const mediaSummarySchema = z.object({
  heroImages: z.number().int().nonnegative(),
  audio: z.number().int().nonnegative(),
  video: z.number().int().nonnegative(),
});

const proofSchema = z.object({
  ok: z.boolean(),
  targetArtifactType: z.enum(ARTIFACT_TYPES).optional(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
});

const corpusPlanSchema = z.object({
  source: z.enum(["selected", "rotation", "explicit"]),
  offset: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative().optional(),
  selected: z.array(
    z.object({
      id: z.string(),
      title: z.string().optional(),
      transcriptStorage: z.enum(["kv", "inline", "none"]).optional(),
      reason: z.string(),
    }),
  ),
  skippedRecent: z.number().int().nonnegative().optional(),
  nextOffset: z.number().int().nonnegative().optional(),
});

const mixPlanSchema = z.object({
  status: z.enum(["ready", "missing", "error"]),
  path: z.literal("artifacts/mix-plan.md"),
  content: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  updatedAt: z.string().optional(),
  error: z.string().optional(),
});

const agentRunSchema = z.object({
  ok: z.boolean(),
  agentRunId: z.string(),
  status: z.enum(["queued", "running", "done", "error"]),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  published: z.array(publishedSchema),
  held: z.array(heldSchema),
  media: mediaSummarySchema,
  corpusPlan: corpusPlanSchema.optional(),
  mixPlan: mixPlanSchema.optional(),
  proof: proofSchema,
  error: z.string().optional(),
  log: z.array(z.string()),
  statusFile: z.string(),
  notes: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  agentRun: agentRunSchema,
});

function summarize(
  state: RunState,
  logTail: number,
  notes: string[] = [],
  targetArtifactType?: ArtifactType,
) {
  const media = summarizePublishedMedia(state.published);
  return {
    ok: state.status === "done",
    agentRunId: state.run_id,
    status: state.status,
    startedAt: state.startedAt,
    ...(typeof state.finishedAt === "number" ? { finishedAt: state.finishedAt } : {}),
    published: state.published,
    held: state.held ?? [],
    media,
    ...(state.corpusPlan ? { corpusPlan: state.corpusPlan } : {}),
    ...(state.mixPlan ? { mixPlan: state.mixPlan } : {}),
    proof: verifyAgentRunProof({
      targetArtifactType,
      published: state.published,
      held: state.held ?? [],
      media,
    }),
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

function targetFromInput(value: (typeof artifactTargetValues)[number]): ArtifactType | undefined {
  return value === "auto" ? undefined : value;
}

export default smithers((ctx) => (
  <Workflow name="agent-run">
    <Task
      id="run"
      output={outputs.agentRun}
      timeoutMs={90 * 60_000}
      heartbeatTimeoutMs={45 * 60_000}
      maxAttempts={1}
    >
      {async () => {
        const logTail = typeof ctx.input.logTail === "number" ? ctx.input.logTail : 40;
        const targetArtifactType = targetFromInput(ctx.input.artifactType ?? "auto");
        const runId = createRunId();
        const lock = acquireRunLock(runId, "smithers-agent-run");
        if (!lock.ok) {
          return summarize(
            {
              run_id: lock.activeRunId,
              status: "running",
              published: [],
              startedAt: Date.now(),
              error: lock.message,
              log: [`${new Date().toISOString()} ${lock.message}`],
            },
            logTail,
            ["Another agent run already holds the shared run lock."],
            targetArtifactType,
          );
        }

        const notes = [
          "This Smithers workflow reuses harness/agent/src/runner.ts so the current TinyCloud delegation and skill behavior stay identical to /agent/run.",
          "Run it only as an operator/dev entry point for now; it now shares the same cross-process run lock as the HTTP server.",
          "For stage-level retry/backpressure and per-stage logs, use the agent-run-staged workflow.",
        ];

        let state: RunState | null = null;
        try {
          state = createRun(runId);
          const session = await AgentSession.bootstrap();
          const active = session.getActive();
          if (!active) {
            markError(
              state,
              new Error("No active delegation found. Connect an agent from Feed or POST /agent/delegation first."),
            );
            return summarize(state, logTail, notes, targetArtifactType);
          }
          await runPipeline(active, state, writeRun, { targetArtifactType });
          return summarize(state, logTail, notes, targetArtifactType);
        } catch (err) {
          if (!state) {
            return summarize(
              {
                run_id: runId,
                status: "error",
                published: [],
                startedAt: Date.now(),
                finishedAt: Date.now(),
                error: err instanceof Error ? err.message : String(err),
                log: [`${new Date().toISOString()} ERROR: ${err instanceof Error ? err.message : String(err)}`],
              },
              logTail,
              notes,
              targetArtifactType,
            );
          }
          markError(state, err);
          return summarize(state, logTail, notes, targetArtifactType);
        } finally {
          releaseRunLock(runId);
        }
      }}
    </Task>
  </Workflow>
));
