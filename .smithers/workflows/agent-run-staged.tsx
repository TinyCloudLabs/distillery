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
  listArtifactRoutes,
  prepareRunScratch,
  RUN_EXECUTION_SOURCES,
  runGenerateStage,
  runListenReadStage,
  runPublishStage,
  type RunState,
} from "../../harness/agent/src/runner.ts";
import { verifyAgentRunProof } from "../../harness/agent/src/run-proof.ts";
import { ARTIFACT_TYPES, type ArtifactType } from "../../skills/_shared/lib/formats.ts";
import {
  acquireRunLock,
  createRun,
  createRunId,
  readRun,
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

const runStatusSchema = z.enum(["queued", "running", "done", "error"]);

const stageBaseSchema = z.object({
  ok: z.boolean(),
  agentRunId: z.string(),
  stage: z.string(),
  status: runStatusSchema,
  executionSource: z
    .object({
      source: z.enum(["agent-http", "smithers-agent-run", "smithers-agent-run-staged"]),
      label: z.string(),
      entrypoint: z.string(),
    })
    .optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  statusFile: z.string(),
  error: z.string().optional(),
  log: z.array(z.string()),
});

const preflightSchema = stageBaseSchema.extend({
  hasDelegation: z.boolean(),
  hasLock: z.boolean(),
  notes: z.array(z.string()),
});

const listenSchema = stageBaseSchema.extend({
  listenStatus: z.enum(["ready", "empty", "error"]),
  transcriptCount: z.number().int().nonnegative(),
  transcripts: z.array(z.string()),
  corpusPlan: corpusPlanSchema.optional(),
});

const generateSchema = stageBaseSchema.extend({
  skipped: z.boolean(),
  transcriptCount: z.number().int().nonnegative(),
  corpusPlan: corpusPlanSchema.optional(),
  mixPlan: mixPlanSchema.optional(),
});

const publishSchema = stageBaseSchema.extend({
  skipped: z.boolean(),
  published: z.array(publishedSchema),
  held: z.array(heldSchema),
  media: mediaSummarySchema,
  corpusPlan: corpusPlanSchema.optional(),
  mixPlan: mixPlanSchema.optional(),
  proof: proofSchema,
});

const cleanupSchema = stageBaseSchema.extend({
  cleaned: z.boolean(),
  published: z.array(publishedSchema),
  held: z.array(heldSchema),
  media: mediaSummarySchema,
  corpusPlan: corpusPlanSchema.optional(),
  mixPlan: mixPlanSchema.optional(),
  proof: proofSchema,
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
    ...(state.executionSource ? { executionSource: state.executionSource } : {}),
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

function targetFromInput(value: (typeof artifactTargetValues)[number]): ArtifactType | undefined {
  return value === "auto" ? undefined : value;
}

function proofFor(state: RunState, targetArtifactType?: ArtifactType) {
  const media = summarizePublishedMedia(state.published);
  return {
    media,
    corpusPlan: state.corpusPlan,
    mixPlan: state.mixPlan,
    proof: verifyAgentRunProof({
      targetArtifactType,
      published: state.published,
      held: state.held ?? [],
      media,
    }),
  };
}

async function assertTargetProofBeforePublish(
  targetArtifactType: ArtifactType | undefined,
  artifactsDir: string,
): Promise<void> {
  if (targetArtifactType !== "clip") return;
  const routes = await listArtifactRoutes(artifactsDir, { preflightMedia: true });
  const clips = routes.filter((route) => route.type === "clip");
  const publishableClip = clips.find((route) => route.publish);
  if (publishableClip) return;
  const reasons = clips
    .map((route) => `${route.type}/${route.slug}: ${route.reason ?? "not publishable"}`)
    .join("; ");
  throw new Error(
    reasons
      ? `Clip proof failed before publish: no publishable video clip (${reasons}).`
      : "Clip proof failed before publish: generation produced no clip artifact.",
  );
}

async function restoreContext(agentRunId: string, targetArtifactType?: ArtifactType): Promise<{
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
    ctx: createPipelineContext(active, state, writeRun, {
      executionSource: RUN_EXECUTION_SOURCES.smithersAgentRunStaged,
      targetArtifactType,
    }),
  };
}

export default smithers((ctx) => {
  const logTailMax = typeof ctx.input.logTail === "number" ? ctx.input.logTail : 40;
  const targetArtifactType = targetFromInput(ctx.input.artifactType ?? "auto");
  const preflight = ctx.outputMaybe("preflight", { nodeId: "preflight" });
  const listen = ctx.outputMaybe("listen", { nodeId: "listen" });
  const generate = ctx.outputMaybe("generate", { nodeId: "generate" });
  const publish = ctx.outputMaybe("publish", { nodeId: "publish" });

  const shouldListen = preflight?.ok === true;
  const shouldGenerate = listen?.ok === true && listen.listenStatus === "ready";
  const shouldPublish = generate?.ok === true && generate.skipped === false;
  const terminal =
    preflight !== undefined &&
    preflight.hasLock === true &&
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
            const notes = [
              "This staged workflow runs the same runner helpers as /agent/run, but exposes Smithers nodes for preflight, listen, generate, publish, and cleanup.",
              "Operator/dev entry point only for now: it shares the cross-process run lock with production /agent/run, but the HTTP endpoint has not moved onto Smithers task execution yet.",
            ];
            const runId = createRunId();
            const lock = acquireRunLock(runId, "smithers-agent-run-staged");
            if (!lock.ok) {
              const state: RunState = {
                run_id: lock.activeRunId,
                status: "running",
                published: [],
                startedAt: Date.now(),
                error: lock.message,
                log: [`${new Date().toISOString()} ${lock.message}`],
              };
              return {
                ...base("preflight", state, logTailMax, false),
                hasDelegation: false,
                hasLock: false,
                notes: [...notes, "Another agent run already holds the shared run lock."],
              };
            }

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
                return { ...base("preflight", state, logTailMax, false), hasDelegation: false, hasLock: true, notes };
              }
              const pipe = createPipelineContext(active, state, writeRun, {
                executionSource: RUN_EXECUTION_SOURCES.smithersAgentRunStaged,
                targetArtifactType,
              });
              state.status = "running";
              pipe.step(
                targetArtifactType
                  ? `run started (target artifact type: ${targetArtifactType})`
                  : "run started",
              );
              await prepareRunScratch(pipe);
              return { ...base("preflight", state, logTailMax, true), hasDelegation: true, hasLock: true, notes };
            } catch (err) {
              if (!state) {
                releaseRunLock(runId);
                state = {
                  run_id: runId,
                  status: "error",
                  published: [],
                  startedAt: Date.now(),
                  finishedAt: Date.now(),
                  error: err instanceof Error ? err.message : String(err),
                  log: [`${new Date().toISOString()} ERROR: ${err instanceof Error ? err.message : String(err)}`],
                };
                return { ...base("preflight", state, logTailMax, false), hasDelegation: false, hasLock: false, notes };
              }
              markError(state, err);
              return { ...base("preflight", state, logTailMax, false), hasDelegation: false, hasLock: true, notes };
            }
          }}
        </Task>

        {shouldListen ? (
          <Task id="listen" output={outputs.listen}>
            {async () => {
              const runId = preflight.agentRunId;
              let state = readRun(runId);
              try {
                const restored = await restoreContext(runId, targetArtifactType);
                state = restored.state;
                const result = await runListenReadStage(restored.ctx);
                if (result.kind === "empty") {
                  return {
                    ...base("listen", state, logTailMax, true),
                    listenStatus: "empty" as const,
                    transcriptCount: 0,
                    transcripts: [],
                    ...(state.corpusPlan ? { corpusPlan: state.corpusPlan } : {}),
                  };
                }
                return {
                  ...base("listen", state, logTailMax, true),
                  listenStatus: "ready" as const,
                  transcriptCount: result.transcripts.length,
                  transcripts: result.transcripts,
                  ...(state.corpusPlan ? { corpusPlan: state.corpusPlan } : {}),
                };
              } catch (err) {
                state = markError(state ?? missingRunState(runId), err);
                return {
                  ...base("listen", state, logTailMax, false),
                  listenStatus: "error" as const,
                  transcriptCount: 0,
                  transcripts: [],
                  ...(state.corpusPlan ? { corpusPlan: state.corpusPlan } : {}),
                };
              }
            }}
          </Task>
        ) : null}

        {shouldGenerate ? (
          <Task
            id="generate"
            output={outputs.generate}
            timeoutMs={90 * 60_000}
            heartbeatTimeoutMs={45 * 60_000}
            maxAttempts={1}
          >
            {async () => {
              const runId = listen.agentRunId;
              let state = readRun(runId);
              try {
                const restored = await restoreContext(runId, targetArtifactType);
                state = restored.state;
                await runGenerateStage(restored.ctx, listen.transcripts);
                return {
                  ...base("generate", state, logTailMax, true),
                  skipped: false,
                  transcriptCount: listen.transcriptCount,
                  ...(state.corpusPlan ? { corpusPlan: state.corpusPlan } : {}),
                  ...(state.mixPlan ? { mixPlan: state.mixPlan } : {}),
                };
              } catch (err) {
                state = markError(state ?? missingRunState(runId), err);
                return {
                  ...base("generate", state, logTailMax, false),
                  skipped: false,
                  transcriptCount: listen.transcriptCount,
                  ...(state.corpusPlan ? { corpusPlan: state.corpusPlan } : {}),
                  ...(state.mixPlan ? { mixPlan: state.mixPlan } : {}),
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
                const restored = await restoreContext(runId, targetArtifactType);
                state = restored.state;
                await assertTargetProofBeforePublish(targetArtifactType, restored.ctx.artifactsDir);
                await runPublishStage(restored.ctx);
                state.status = "done";
                state.finishedAt = Date.now();
                writeRun(state);
                const { media, corpusPlan, mixPlan, proof } = proofFor(state, targetArtifactType);
                return {
                  ...base("publish", state, logTailMax, true),
                  skipped: false,
                  published: state.published,
                  held: state.held ?? [],
                  media,
                  ...(corpusPlan ? { corpusPlan } : {}),
                  ...(mixPlan ? { mixPlan } : {}),
                  proof,
                };
              } catch (err) {
                state = markError(state ?? missingRunState(runId), err);
                const { media, corpusPlan, mixPlan, proof } = proofFor(state, targetArtifactType);
                return {
                  ...base("publish", state, logTailMax, false),
                  skipped: false,
                  published: state.published,
                  held: state.held ?? [],
                  media,
                  ...(corpusPlan ? { corpusPlan } : {}),
                  ...(mixPlan ? { mixPlan } : {}),
                  proof,
                };
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
              try {
                await cleanupRunScratch(runId);
              } finally {
                releaseRunLock(runId);
              }
              const { media, corpusPlan, mixPlan, proof } = proofFor(state, targetArtifactType);
              return {
                ...base("cleanup", state, logTailMax, state.status !== "error"),
                cleaned: true,
                published: state.published,
                held: state.held ?? [],
                media,
                ...(corpusPlan ? { corpusPlan } : {}),
                ...(mixPlan ? { mixPlan } : {}),
                proof,
              };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
