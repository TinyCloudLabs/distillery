// runner.ts — the run-under-delegation pipeline (MVP). Executes the artifact
// pipeline's stages as direct skill-script invocations. The repo carries
// Smithers dev workflows, but the production HTTP endpoint still uses this
// runner until a bespoke Smithers agent-run workflow replaces it.
//
//   listen-read → generate → publish        (PUBLISH-ONLY — see below)
//
// PUBLISH-ONLY, NO SCHEMA DDL (team coordination decision, 2026-06-14): the
// agent's delegation is intentionally MINIMAL — Listen [read], artifacts/feed
// [read,write], media KV [get,put,…], interactions [read]. It has NO write on
// the `interactions` or `control` DBs. So the agent CANNOT (and must not) run
// the 3-DB bootstrap-schema (it would 401 on the interactions/control CREATE
// TABLE and crash the run). The FRONT END owns table bootstrap: the owner's own
// session (read/write on its feed + interactions via the broadened manifest)
// creates the tables on connect. The agent run is therefore publish-only:
// tc-publish does a pure INSERT into `feed` + KV put into `media` (verified:
// publish-lib touches ONLY feed + media, never interactions/control/bootstrap),
// which the delegation covers. The agent NEVER writes interactions — preserving
// the §1 reader-write / agent-read privilege split.
//
// HOW THE DELEGATION THREADS IN (the whole point): each tc-backed spawn runs with
//   env HOME=<config.tcHome>   (so tc reads the sandbox profile, not the user's ~)
//   --space <delegation.spaceId>
// so the skills read the delegator's Listen + write the delegator's artifacts,
// entirely as the delegator. NEVER an owner/cli-test key (hard rule §4).
//
// EMPTY-LISTEN-SAFE (§ plan): listen-read exits non-zero with "No non-empty
// transcripts" when the user has no Listen data — we treat ONLY that explicit
// condition as a VALID run that publishes 0 artifacts (skip generate + publish).
// Any tc/auth/space failure must surface as an error; masking a 401 as "empty"
// destroys the operator's ability to fix the delegation.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.ts";
import type { ActiveDelegation } from "./session.ts";
import { classifyListenReadResult } from "./listen-read-outcome.ts";
import { summarizeRunProofMedia, verifyAgentRunProof, type AgentRunProof } from "./run-proof.ts";
import { ARTIFACT_TYPES, isOutwardType, type ArtifactType } from "../../../skills/_shared/lib/formats.ts";
import { sqlQuery } from "../../../skills/_shared/lib/tc.ts";

const INTERACTIONS_DB = "xyz.tinycloud.artifacts/interactions";
const INTERACTION_SUMMARY_LIMIT = 50;

export type RunStatus = "queued" | "running" | "done" | "error";

export interface PublishedRef {
  type: string;
  slug: string;
  media?: {
    heroImage: boolean;
    audio: boolean;
    video: boolean;
  };
}

export interface HeldArtifactRef {
  type: string;
  slug: string;
  reason: string;
}

export interface RunMediaSummary {
  heroImages: number;
  audio: number;
  video: number;
}

export interface InteractionBackpressureRow {
  artifact_id: string;
  artifact_type: string;
  action: string;
  note: string | null;
  recorded_at: string;
}

export interface InteractionBackpressure {
  status: "ready" | "empty" | "unavailable";
  lines: string[];
  reason?: string;
}

export interface RunState {
  run_id: string;
  status: RunStatus;
  published: PublishedRef[];
  held?: HeldArtifactRef[];
  media?: RunMediaSummary;
  targetArtifactType?: ArtifactType;
  proof?: AgentRunProof;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** Free-text stage log (for debugging; not part of the API contract). */
  log: string[];
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

type EnvMode = "sandbox" | "generate";

interface RunHeartbeatInfo {
  pid?: number;
  startedAt: number;
  elapsedMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}

interface RunHooks {
  heartbeatMs?: number;
  onHeartbeat?: (info: RunHeartbeatInfo) => void | Promise<void>;
}

export interface PipelineContext {
  active: ActiveDelegation;
  state: RunState;
  onProgress: (s: RunState) => void;
  space: string;
  corpusDir: string;
  artifactsDir: string;
  targetArtifactType?: ArtifactType;
  step: (msg: string) => void;
}

export interface PipelineOptions {
  /**
   * Optional live-generation nudge for Smithers/operator runs. This is never a
   * quota or force flag: the generator must still skip the target when the
   * corpus does not earn it or prerequisites are missing.
   */
  targetArtifactType?: ArtifactType;
}

export type ListenReadStageResult =
  | { kind: "ready"; transcripts: string[] }
  | { kind: "empty" };

interface ListenReadCursor {
  nextOffset: number;
  updatedAt?: string;
  lastRunId?: string;
}

export function parseListenReadCursor(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as Partial<ListenReadCursor>;
    const nextOffset = parsed.nextOffset;
    return typeof nextOffset === "number" && Number.isInteger(nextOffset) && nextOffset >= 0
      ? nextOffset
      : 0;
  } catch {
    return 0;
  }
}

export function nextListenReadOffset(offset: number, transcriptCount: number): number {
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const safeCount = Number.isInteger(transcriptCount) && transcriptCount > 0 ? transcriptCount : 1;
  return safeOffset + safeCount;
}

export function buildListenReadArgs(corpusDir: string, count: number, space: string, offset: number): string[] {
  return [
    SKILLS.listenRead,
    "--out",
    corpusDir,
    "--count",
    String(count),
    "--offset",
    String(Math.max(0, Math.floor(offset))),
    "--space",
    space,
  ];
}

/**
 * Run a command from the repo root.
 *
 * `mode`:
 *  - "sandbox" (default) — full inherited env + HOME=config.tcHome so every `tc`
 *    the skill shells out to reads the SANDBOX delegated profile. Used for the
 *    tc-backed stages (listen-read, publish): they run as the delegator.
 *  - "generate" — the headless `claude -p` step over UNTRUSTED transcript text.
 *    Two layers of mitigation (prompt text alone is NOT a guardrail):
 *      a. SCRUBBED env (buildGenerateEnv): an allowlist that drops every
 *         secret-bearing var (no TC_/AWS_/DB creds, no agent secrets) — so an
 *         injection can't exfiltrate them from the environment.
 *      b. TOOL RESTRICTION (buildGenerationArgs): --allowedTools for the
 *         workflow (file ops + `Bash(bun:*)`/`Bash(rm:*)`), --disallowedTools
 *         hard-blocking `tc`/network/keychain/web tools + a path-scoped Read/
 *         Glob/Grep deny of the agent state dir, --no-session-persistence, and
 *         --add-dir scoped to ONLY skills + corpus + artifacts (NOT repoRoot).
 *      c. CREDENTIAL PLACEMENT (config.ts): the agent state dir lives OUTSIDE
 *         repoRoot, so the credentials are not under cwd or any --add-dir.
 *
 *    HOME stays the REAL home here (NOT a minimal sandbox). claude's login token
 *    lives in the macOS Keychain, and keychain access is bound to the real $HOME
 *    + per-user session vars — a minimal HOME makes `claude -p` report "Not
 *    logged in" (verified empirically). HONEST LIMIT: claude's Read tool in -p
 *    mode can still open arbitrary ABSOLUTE paths and `bun -e` can read any file
 *    this process can, so the above RAISE THE BAR + close the reported in-repo
 *    add-dir vector but do NOT fully sandbox the filesystem. Real confinement
 *    (separate uid / container / TEE) is the phase-2 (Phala) hardening.
 */
function run(
  cmd: string,
  args: string[],
  mode: EnvMode = "sandbox",
  hooks: RunHooks = {},
): Promise<SpawnResult> {
  const env =
    mode === "sandbox"
      ? { ...process.env, HOME: config.tcHome }
      : buildGenerateEnv();
  return new Promise((resolve, reject) => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, {
      cwd: config.repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (hooks.onHeartbeat) {
      heartbeat = setInterval(() => {
        Promise.resolve(
          hooks.onHeartbeat?.({
            pid: child.pid,
            startedAt,
            elapsedMs: Date.now() - startedAt,
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: Buffer.byteLength(stderr),
          }),
        ).catch(() => {
          // Best-effort status visibility; never fail the child for log writes.
        });
      }, hooks.heartbeatMs ?? 30_000);
    }
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (heartbeat) clearInterval(heartbeat);
      reject(err);
    });
    child.on("close", (code) => {
      if (heartbeat) clearInterval(heartbeat);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

// ── GENERATE-STAGE SANDBOX (scrub the env claude -p inherits) ───────────────
// The generate child reads untrusted Listen transcripts; a prompt-injected
// transcript shouldn't be able to exfiltrate env secrets or casually shell out.
// buildGenerateEnv gives it ONLY what `claude -p` + the skill scripts (run via
// `bun`) + optional media providers genuinely need. FAL_KEY is passed only when
// AGENT_ENABLE_VIDEO=1 because make-clip is slower and spend-bearing. NOTE: `bun` and `tc` live in
// the SAME dir (~/.bun/bin), so PATH can't drop `tc` without losing `bun`; the
// real `tc`/arbitrary-Bash guardrail is the claude --allowedTools/--disallowedTools
// restriction in buildGenerationArgs (no unrestricted Bash). Filesystem reads of
// ~/.tinycloud are NOT blocked here — see the run() doc above; that's phase 2.

/** PATH for the generate child: claude/node (/opt/homebrew/bin) + bun
 *  (~/.bun/bin, required to run the skill scripts). Overridable via
 *  AGENT_GENERATE_PATH for non-Homebrew layouts. */
function generatePath(): string {
  const override = process.env.AGENT_GENERATE_PATH?.trim();
  if (override) return override;
  const home = process.env.HOME ?? "";
  return [`${home}/.bun/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
}

function expandHome(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  return path === "~" ? home : path.replace(/^~\//, `${home}/`);
}

function developmentEnvPaths(): string[] {
  const configured = process.env.DEV_DISTILLERY_ENV?.trim();
  if (configured) return [expandHome(configured)];
  return [expandHome("~/development.nosync/distillery/.env")];
}

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (!key) continue;
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readDevelopmentEnv(): Record<string, string> {
  for (const path of developmentEnvPaths()) {
    if (!existsSync(path)) continue;
    try {
      return parseEnvText(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function devOrProcessEnv(devEnv: Record<string, string>, key: string): string | undefined {
  const processValue = process.env[key];
  if (typeof processValue === "string" && processValue.length > 0) return processValue;
  const devValue = devEnv[key];
  return typeof devValue === "string" && devValue.length > 0 ? devValue : undefined;
}

function buildGenerationProviderEnv(devEnv = readDevelopmentEnv()): Record<string, string> {
  const env: Record<string, string> = {};
  const ALLOW = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GEMINI_API_KEY",
    "GOOGLE_AI_API_KEY",
    "GOOGLE_API_KEY",
    "AGENT_GEN_MODEL",
    "AGENT_ENABLE_VIDEO",
  ];
  for (const key of ALLOW) {
    const value = devOrProcessEnv(devEnv, key);
    if (value) env[key] = value;
  }
  if (devOrProcessEnv(devEnv, "AGENT_ENABLE_VIDEO") === "1") {
    const fal = devOrProcessEnv(devEnv, "FAL_KEY");
    if (fal) env.FAL_KEY = fal;
  }
  return env;
}

interface GenerationProviderAvailability {
  geminiEnabled: boolean;
  videoEnabled: boolean;
  falVideoEnabled: boolean;
  veoVideoEnabled: boolean;
}

function generationProviderAvailability(): GenerationProviderAvailability {
  const providerEnv = buildGenerationProviderEnv();
  const geminiEnabled = Boolean(
    providerEnv.GOOGLE_AI_API_KEY || providerEnv.GEMINI_API_KEY || providerEnv.GOOGLE_API_KEY,
  );
  const videoFlagEnabled = providerEnv.AGENT_ENABLE_VIDEO === "1";
  const falVideoEnabled = videoFlagEnabled && Boolean(providerEnv.FAL_KEY);
  const veoVideoEnabled = videoFlagEnabled && geminiEnabled;
  return {
    geminiEnabled,
    videoEnabled: falVideoEnabled || veoVideoEnabled,
    falVideoEnabled,
    veoVideoEnabled,
  };
}

/**
 * The scrubbed env for the generate child. Starts from a small fixed base, then
 * adds ONLY allowlisted passthroughs — never the full process.env. Two groups:
 *  1. model-provider creds the generate step legitimately uses (claude's key,
 *     the optional Gemini key, and gated FAL video key);
 *  2. the per-user session vars macOS needs for `claude` to reach its login
 *     token in the Keychain (USER/LOGNAME/__CF_USER_TEXT_ENCODING + the real
 *     per-user TMPDIR). Without these, `claude -p` reports "Not logged in"
 *     (verified). Everything else (TC_/AWS_/DB creds, the agent's own secrets)
 *     is intentionally DROPPED.
 */
function buildGenerateEnv(): Record<string, string> {
  const providerEnv = buildGenerationProviderEnv();
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? "", // real home — claude's keychain auth needs it
    PATH: generatePath(),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: process.env.TERM ?? "xterm-256color",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    ...providerEnv,
  };
  const ALLOW = [
    // macOS keychain-session vars (so claude finds its login token)
    "USER",
    "LOGNAME",
    "__CF_USER_TEXT_ENCODING",
  ];
  for (const k of ALLOW) {
    const v = process.env[k];
    if (typeof v === "string" && v.length > 0) env[k] = v;
  }
  return env;
}

// Every skill runs under the delegated profile via the SANDBOX DEFAULT PROFILE:
// writeGlobalConfig set config.json's defaultProfile to config.profileName, and
// HOME points tc at that sandbox — so `tc` (no --profile) IS the delegate. We
// therefore only ever pass --space (the user's delegated space). bootstrap-
// schema + publish reject an unknown --profile, so NOT passing it is required;
// listen-read accepts it but the default suffices, keeping all three uniform.

const SKILLS = {
  listenRead: "skills/tc-listen-read/scripts/listen-read.ts",
  publish: "skills/tc-publish/scripts/publish.ts",
} as const;

/**
 * Drive the whole pipeline for one run under `active`. Mutates `state` in place
 * (stage by stage) so GET /agent/run/:id reflects progress; the caller persists
 * state after each await via the onProgress hook.
 */
export async function runPipeline(
  active: ActiveDelegation,
  state: RunState,
  onProgress: (s: RunState) => void,
  options: PipelineOptions = {},
): Promise<void> {
  const ctx = createPipelineContext(active, state, onProgress, options);
  state.targetArtifactType = ctx.targetArtifactType;

  state.status = "running";
  ctx.step(
    ctx.targetArtifactType
      ? `run started (target artifact type: ${ctx.targetArtifactType})`
      : "run started",
  );

  await prepareRunScratch(ctx);

  try {
    // NO bootstrap step: the front end owns table creation (it has feed +
    // interactions write on the owner's own session). The agent's minimal
    // delegation can't CREATE the interactions/control tables, so running
    // bootstrap-schema here would 401 and crash. tc-publish below does a pure
    // INSERT into the pre-existing `feed` table (+ media KV) — both delegated.

    const read = await runListenReadStage(ctx);
    if (read.kind === "empty") return;

    await runGenerateStage(ctx, read.transcripts);
    await runPublishStage(ctx);

    state.status = "done";
    state.finishedAt = Date.now();
    onProgress(state);
  } finally {
    // Wipe the run's scratch (Listen transcripts in corpus/ + generated
    // artifacts/) on BOTH success and error — they hold the user's raw Listen
    // data and shouldn't linger on disk. status.json is preserved for polling.
    await cleanupRunScratch(state.run_id);
  }
}

export function createPipelineContext(
  active: ActiveDelegation,
  state: RunState,
  onProgress: (s: RunState) => void,
  options: PipelineOptions = {},
): PipelineContext {
  const corpusDir = join(config.runsDir, state.run_id, "corpus");
  const artifactsDir = join(config.runsDir, state.run_id, "artifacts");
  return {
    active,
    state,
    onProgress,
    space: active.spaceId,
    corpusDir,
    artifactsDir,
    ...(options.targetArtifactType ? { targetArtifactType: options.targetArtifactType } : {}),
    step: (msg: string) => {
      state.log.push(`${new Date().toISOString()} ${msg}`);
      onProgress(state);
    },
  };
}

export async function prepareRunScratch(ctx: PipelineContext): Promise<void> {
  // 0700: corpus holds the user's RAW Listen transcripts — never group/other-readable.
  await mkdir(ctx.corpusDir, { recursive: true, mode: 0o700 });
  await mkdir(ctx.artifactsDir, { recursive: true, mode: 0o700 });
}

export async function runListenReadStage(ctx: PipelineContext): Promise<ListenReadStageResult> {
  // LISTEN-READ — pull the user's transcripts into a per-run corpus. EMPTY-SAFE:
  // exit 1 + "No non-empty transcripts" → 0 transcripts → valid, done.
  const configuredOffset = config.transcriptRotation
    ? await readListenReadCursor()
    : config.transcriptOffset;
  let usedOffset = configuredOffset;
  ctx.step(
    `listen-read: fetching the user's Listen transcripts ` +
      `(count ${config.transcriptCount}, offset ${configuredOffset})`,
  );
  let read = await executeListenRead(ctx, configuredOffset);
  logListenReadOutput(ctx, read);

  let transcripts = await listCorpus(ctx.corpusDir);
  let readOutcome = classifyListenReadResult(read);
  if (
    configuredOffset > 0 &&
    transcripts.length === 0 &&
    readOutcome.kind !== "error"
  ) {
    ctx.step(`listen-read: offset ${configuredOffset} returned no transcripts; retrying from offset 0`);
    await rm(ctx.corpusDir, { recursive: true, force: true });
    await mkdir(ctx.corpusDir, { recursive: true, mode: 0o700 });
    usedOffset = 0;
    read = await executeListenRead(ctx, 0);
    logListenReadOutput(ctx, read);
    transcripts = await listCorpus(ctx.corpusDir);
    readOutcome = classifyListenReadResult(read);
  }
  if (readOutcome.kind === "error") {
    const code = readOutcome.code ? `${readOutcome.code}: ` : "";
    ctx.step(`listen-read: failed (${code}${readOutcome.message})`);
    throw new Error(`listen-read failed (${code}${readOutcome.message})`);
  }
  if (transcripts.length === 0) {
    if (readOutcome.kind === "ok") {
      const detail = "listen-read exited 0 but wrote no transcript files";
      ctx.step(`listen-read: failed (${detail})`);
      throw new Error(`listen-read failed (${detail})`);
    }
    ctx.step(
      `listen-read: 0 transcripts (empty-Listen path) — read exit=${read.code}. ` +
        `Completing with 0 artifacts (valid).`,
    );
    ctx.state.status = "done";
    ctx.state.finishedAt = Date.now();
    ctx.onProgress(ctx.state);
    return { kind: "empty" };
  }
  if (config.transcriptRotation) {
    const nextOffset = nextListenReadOffset(usedOffset, config.transcriptCount);
    await writeListenReadCursor(nextOffset, ctx.state.run_id);
    ctx.step(`listen-read: ${transcripts.length} transcript(s) fetched; next offset ${nextOffset}`);
  } else {
    ctx.step(`listen-read: ${transcripts.length} transcript(s) fetched`);
  }
  return { kind: "ready", transcripts };
}

async function executeListenRead(ctx: PipelineContext, offset: number): Promise<SpawnResult> {
  return run(
    "bun",
    buildListenReadArgs(ctx.corpusDir, config.transcriptCount, ctx.space, offset),
    "sandbox",
    {
      heartbeatMs: config.stageHeartbeatMs,
      onHeartbeat: () => {
        ctx.step(`listen-read: still fetching transcripts (offset ${offset})`);
      },
    },
  );
}

function logListenReadOutput(ctx: PipelineContext, read: SpawnResult): void {
  const stdoutTail = boundedProcessOutput("stdout", read.stdout);
  const stderrTail = boundedProcessOutput("stderr", read.stderr);
  if (stdoutTail) ctx.step(`listen-read ${stdoutTail}`);
  if (stderrTail && read.code !== 0) ctx.step(`listen-read ${stderrTail}`);
}

async function readListenReadCursor(): Promise<number> {
  try {
    return parseListenReadCursor(await readFile(config.listenReadCursorPath, "utf8"));
  } catch {
    return config.transcriptOffset;
  }
}

async function writeListenReadCursor(nextOffset: number, runId: string): Promise<void> {
  await writeFile(
    config.listenReadCursorPath,
    JSON.stringify(
      {
        nextOffset,
        updatedAt: new Date().toISOString(),
        lastRunId: runId,
      } satisfies ListenReadCursor,
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}

export async function runGenerateStage(
  ctx: PipelineContext,
  transcripts: string[],
): Promise<void> {
  // GENERATE — headless claude over the corpus → publishable Feed artifact first,
  // optional approval-held outward draft second.
  ctx.step("generate: distilling publishable feed artifact from the corpus");
  const backpressure = await loadInteractionBackpressure(ctx);
  if (backpressure.status === "ready") {
    ctx.step(`feedback: loaded interaction backpressure (${backpressure.lines.length} line(s))`);
  } else if (backpressure.status === "empty") {
    ctx.step("feedback: no reader interactions yet");
  } else {
    ctx.step(`feedback: unavailable (${backpressure.reason ?? "unknown error"})`);
  }
  // SCRUBBED env + minimal HOME (only a ~/.claude symlink): claude reads its own
  // credentials and writes artifact files locally, but a prompt-injected
  // transcript can't reach ~/.tinycloud, the agent state, env secrets, or `tc`.
  const gen = await run(
    "claude",
    buildGenerationArgs(ctx.corpusDir, ctx.artifactsDir, transcripts, {
      targetArtifactType: ctx.targetArtifactType,
      interactionBackpressure: backpressure,
    }),
    "generate",
    {
      heartbeatMs: config.stageHeartbeatMs,
      onHeartbeat: async (info) => {
        const routes = await listArtifactRoutes(ctx.artifactsDir);
        const tree = await summarizeArtifactTree(ctx.artifactsDir);
        ctx.step(
          `generate: still running (${summarizeArtifactRoutes(routes)}; ` +
            `${formatHeartbeatInfo(info)}; ${tree})`,
        );
      },
    },
  );
  if (gen.code !== 0) {
    throw new Error(`generate failed (exit ${gen.code}): ${gen.stderr.slice(-800) || gen.stdout.slice(-800)}`);
  }
  const routes = await listArtifactRoutes(ctx.artifactsDir);
  ctx.step(`generate: completed (${summarizeArtifactRoutes(routes)})`);
  const stdoutTail = boundedProcessOutput("stdout", gen.stdout);
  if (stdoutTail) ctx.step(`generate: ${stdoutTail}`);
  const stderrTail = boundedProcessOutput("stderr", gen.stderr);
  if (stderrTail) ctx.step(`generate: ${stderrTail}`);
}

function isMissingInteractionsTable(message: string): boolean {
  return /no such table/i.test(message);
}

function tcSandboxEnv(): Record<string, string> {
  return { HOME: config.tcHome };
}

function zipInteractionRows(columns: string[], rows: unknown[][]): InteractionBackpressureRow[] {
  return rows.flatMap((row) => {
    const value = Object.fromEntries(columns.map((column, index) => [column, row[index]]));
    if (
      typeof value.artifact_id !== "string" ||
      typeof value.artifact_type !== "string" ||
      typeof value.action !== "string" ||
      typeof value.recorded_at !== "string"
    ) {
      return [];
    }
    return [
      {
        artifact_id: value.artifact_id,
        artifact_type: value.artifact_type,
        action: value.action,
        note: typeof value.note === "string" && value.note.trim() ? value.note.trim() : null,
        recorded_at: value.recorded_at,
      },
    ];
  });
}

export function summarizeInteractionBackpressure(
  rows: readonly InteractionBackpressureRow[],
): InteractionBackpressure {
  if (rows.length === 0) return { status: "empty", lines: [] };

  const actionCounts = new Map<string, number>();
  const typeCounts = new Map<string, Map<string, number>>();
  const notes: string[] = [];

  for (const row of rows) {
    actionCounts.set(row.action, (actionCounts.get(row.action) ?? 0) + 1);
    const byAction = typeCounts.get(row.artifact_type) ?? new Map<string, number>();
    byAction.set(row.action, (byAction.get(row.action) ?? 0) + 1);
    typeCounts.set(row.artifact_type, byAction);
    if (row.note && notes.length < 5) {
      notes.push(`${row.action} on ${row.artifact_type}/${row.artifact_id}: ${row.note}`);
    }
  }

  const actionSummary = [...actionCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([action, count]) => `${action}=${count}`)
    .join(", ");
  const typeSummary = [...typeCounts.entries()]
    .sort((a, b) => {
      const aTotal = [...a[1].values()].reduce((sum, count) => sum + count, 0);
      const bTotal = [...b[1].values()].reduce((sum, count) => sum + count, 0);
      return bTotal - aTotal || a[0].localeCompare(b[0]);
    })
    .slice(0, 6)
    .map(([type, byAction]) => {
      const parts = [...byAction.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([action, count]) => `${action}=${count}`)
        .join(", ");
      return `${type}: ${parts}`;
    });

  return {
    status: "ready",
    lines: [
      `Recent interactions: ${rows.length} event(s); ${actionSummary}.`,
      ...typeSummary.map((line) => `By type: ${line}.`),
      ...notes.map((line) => `Reader note: ${line}`),
    ],
  };
}

export async function loadInteractionBackpressure(
  ctx: PipelineContext,
): Promise<InteractionBackpressure> {
  try {
    const result = await sqlQuery(
      "SELECT artifact_id, artifact_type, action, note, recorded_at " +
        "FROM interaction ORDER BY recorded_at DESC LIMIT ?",
      { db: INTERACTIONS_DB, space: ctx.active.spaceId },
      [INTERACTION_SUMMARY_LIMIT],
      { env: tcSandboxEnv() },
    );
    return summarizeInteractionBackpressure(zipInteractionRows(result.columns, result.rows));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isMissingInteractionsTable(message)) return { status: "empty", lines: [] };
    return {
      status: "unavailable",
      lines: [],
      reason: message.slice(0, 240),
    };
  }
}

export async function runPublishStage(ctx: PipelineContext): Promise<void> {
  // PUBLISH — each generated artifact to the user's xyz.tinycloud.artifacts
  // (KV media + SQL feed row, approval_status='approved'), under delegation.
  const artifactRoutes = await listArtifactRoutes(ctx.artifactsDir, { preflightMedia: true });
  const publishable = artifactRoutes.filter((route) => route.publish);
  const drafts = artifactRoutes.filter((route) => !route.publish);
  ctx.state.held = drafts.map((draft) => ({
    type: draft.type,
    slug: draft.slug,
    reason: draft.reason ?? "not publishable",
  }));
  for (const route of artifactRoutes) {
    for (const warning of route.mediaWarnings ?? []) {
      ctx.step(`artifact media: ${route.type}/${route.slug}: ${warning}`);
    }
  }
  ctx.step(
    `publish: ${publishable.length} artifact(s) to the user's space; ` +
      `${drafts.length} draft(s) held for approval`,
  );
  for (const draft of drafts) {
    ctx.step(`publish: held draft ${draft.type}/${draft.slug} (${draft.reason})`);
  }
  for (const artifact of publishable) {
    const label = `${artifact.type}/${artifact.slug}`;
    ctx.step(`publish: publishing ${label}`);
    await stampArtifactRunProvenance(artifact.dir, ctx);
    const pub = await run(
      "bun",
      [SKILLS.publish, artifact.dir, "--space", ctx.active.spaceId, "--json"],
      "sandbox",
      {
        heartbeatMs: config.stageHeartbeatMs,
        onHeartbeat: () => {
          ctx.step(`publish: still publishing ${label}`);
        },
      },
    );
    if (pub.code !== 0) {
      throw new Error(
        `publish failed for ${artifact.dir} (exit ${pub.code}): ${pub.stderr.slice(-800) || pub.stdout.slice(-800)}`,
      );
    }
    const ref = publishedRefFromPublishStdout(
      pub.stdout,
      (await readArtifactRef(artifact.dir)) ?? { type: artifact.type, slug: artifact.slug },
    );
    if (ref) ctx.state.published.push(ref);
    ctx.step(`publish: ${ref ? `${ref.type}/${ref.slug}${formatMediaSummary(ref)}` : label} published`);
  }
  ctx.state.media = summarizeRunProofMedia(ctx.state.published);
  ctx.state.proof = verifyAgentRunProof({
    targetArtifactType: ctx.targetArtifactType,
    published: ctx.state.published,
    held: ctx.state.held ?? [],
    media: ctx.state.media,
  });
  if (ctx.targetArtifactType) {
    ctx.step(
      `publish: target proof ${ctx.state.proof.ok ? "passed" : "failed"} for ${ctx.targetArtifactType}`,
    );
  } else {
    ctx.onProgress(ctx.state);
  }
}

export async function stampArtifactRunProvenance(
  artifactDir: string,
  ctx: PipelineContext,
): Promise<void> {
  const jsonPath = join(artifactDir, "artifact.json");
  const raw = JSON.parse(await readFile(jsonPath, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`cannot stamp provenance for malformed artifact ${jsonPath}`);
  }
  const artifact = raw as Record<string, unknown>;
  const existingProducer =
    artifact.producer !== null &&
    typeof artifact.producer === "object" &&
    !Array.isArray(artifact.producer)
      ? (artifact.producer as Record<string, unknown>)
      : {};

  artifact.producer = {
    ...existingProducer,
    pipeline: "artifactory-agent",
    run_id: ctx.state.run_id,
    delegated_space: ctx.active.spaceId,
    delegation_cid: ctx.active.delegationCid,
    delegation_expires_at: ctx.active.expiresAt,
    ...(ctx.targetArtifactType ? { target_artifact_type: ctx.targetArtifactType } : {}),
    media_focus: config.mediaFocus,
    published_by_agent_at: new Date().toISOString(),
  };

  await writeFile(jsonPath, JSON.stringify(artifact, null, 2) + "\n");
}

export function buildMediaFocusStep(
  focus: "balanced" | "podcast" | "video",
  providers: GenerationProviderAvailability,
): string[] {
  if (focus === "podcast") {
    return providers.geminiEnabled
      ? [
          "MEDIA FOCUS: this run is intentionally trying to prove the podcast",
          "audio path. Before filling the run with cards/articles, look for ONE",
          "sustained through-line with temporal development that deserves",
          "make-podcast. If it clears the podcast bar, make that podcast the",
          "first publishable artifact. If no real episode lead exists, say so",
          "in the final summary and continue with ordinary publishable artifacts.",
        ]
      : [
          "MEDIA FOCUS REQUESTED: podcast, but no Gemini provider is configured.",
          "Do not create a podcast shell. Continue with ordinary publishable",
          "artifacts and state that podcast audio was unavailable.",
        ];
  }

  if (focus === "video") {
    return providers.videoEnabled
      ? [
          "MEDIA FOCUS: this run is intentionally trying to prove the video",
          "clip path. Treat this as an operator proof of the media pipeline:",
          "prefer a clear, simple, transcript-grounded visual metaphor over a",
          "perfect editorial short. Try to produce ONE clip artifact before",
          "filling the run with text cards. Prefer the Gemini/Veo",
          "make-cheap-video path when available; use make-clip only when",
          "FAL/Seedance is the available provider or continuity needs the",
          "higher-control reference-video path.",
        ]
      : [
          "MEDIA FOCUS REQUESTED: video, but AGENT_ENABLE_VIDEO=1 plus a",
          "video-capable provider is required. Gemini enables make-cheap-video;",
          "FAL_KEY enables make-clip. Do not create a clip shell. Continue with",
          "ordinary publishable artifacts and state that video was unavailable.",
        ];
  }

  return [
    "MEDIA FOCUS: balanced. Pick the best formats for the material; do not",
    "force audio or video just for variety.",
  ];
}

export function buildTargetArtifactTypeStep(target?: ArtifactType): string[] {
  if (!target) {
    return [
      "ARTIFACT TARGET: auto. Use the strongest format the material earns.",
    ];
  }

  const common = [
    `ARTIFACT TARGET: ${target}. This run is deliberately testing the ${target}`,
    "path, but quality still wins: do NOT create a weak, duplicate, or",
    "prerequisite-missing artifact just to satisfy the target. If the corpus",
    "does not earn this type, say why in the final summary and use the best",
    "publishable format instead.",
  ];

  switch (target) {
    case "insight-card":
      return [
        ...common,
        "Try `hot-take` or `extract-insights` first for a compact, quote-anchored",
        "internal artifact. Prefer one sharp operating lesson over a generic recap.",
      ];
    case "article":
      return [
        ...common,
        "Try `write-article` first when one transcript thread has enough narrative",
        "development for a longform internal piece.",
      ];
    case "podcast":
      return [
        ...common,
        "Try `make-podcast` first only when there is a sustained through-line with",
        "temporal development and real Gemini TTS is available.",
      ];
    case "clip":
      return [
        ...common,
        "This is an operator proof of the clip pipeline. Try `make-cheap-video`",
        "first when AGENT_ENABLE_VIDEO=1 plus Gemini/Veo are available. Use",
        "`make-clip` when AGENT_ENABLE_VIDEO=1 plus FAL_KEY are available and",
        "the higher-control reference-video path is specifically needed.",
        "Use the clearest transcript-grounded visual metaphor you can find; do",
        "not require a perfect editorial reversal before proving the media path.",
        "Text-only artifacts are not a substitute for this target.",
      ];
    case "digest":
      return [
        ...common,
        "Try `write-digest` first when 2-3 related threads deserve a compact",
        "roundup rather than one long article.",
      ];
    case "social-post":
      return [
        ...common,
        "This is an approval-held outward draft. First satisfy the publishable feed",
        "set if the material earns it, then try `banger-extractor` for one public",
        "social-post draft.",
      ];
    case "investor-update-snippet":
      return [
        ...common,
        "This is an approval-held outward draft. First satisfy the publishable feed",
        "set if the material earns it, then try `investor-snippet` only for an",
        "investor-safe update grounded in verified transcript evidence.",
      ];
    case "quote-card":
      return [
        ...common,
        "`quote-card` packages an already-approved artifact. In a fresh run it may",
        "be blocked by that prerequisite; if so, say so and do not fabricate one.",
      ];
    case "person-brief":
      return [
        ...common,
        "Try `person-brief` only when the corpus has a recurring, identity-grounded",
        "person worth briefing. Every claim needs evidence; skip if role/name",
        "confidence is thin.",
      ];
  }
}

export function buildInteractionBackpressureStep(
  backpressure?: InteractionBackpressure,
): string[] {
  if (!backpressure || backpressure.status === "empty") {
    return [
      "READER BACKPRESSURE: no Feed interaction signals yet. Generate from corpus",
      "quality, novelty, and the explicit instructions above.",
    ];
  }
  if (backpressure.status === "unavailable") {
    return [
      "READER BACKPRESSURE: unavailable. Continue generation, but mention in the",
      "final summary that interaction backpressure could not be read.",
      backpressure.reason ? `Reason: ${backpressure.reason}` : "",
    ].filter(Boolean);
  }
  return [
    "READER BACKPRESSURE: recent Feed interactions from TinyCloud are below.",
    "Treat this as a weak prior, not a settled preference model. Early feedback",
    "is noisy and may regress toward the user's real mean as more artifacts land.",
    "Preserve exploration unless a signal is repeated and directionally clear.",
    "Treat `more` and `save` as positive pull, `less` and `already_knew` as",
    "suppression/novelty calibration, and `wrong` as an accuracy warning.",
    "Do not blindly repeat liked artifacts; generalize the underlying topic,",
    "format, source, or level of specificity when the corpus earns it.",
    ...backpressure.lines.map((line) => `- ${line}`),
  ];
}

export function buildArtifactMixPlanStep(options: {
  targetArtifacts: number;
  artifactsDir: string;
  mediaFocus: "balanced" | "podcast" | "video";
  providers: GenerationProviderAvailability;
  targetArtifactType?: ArtifactType;
}): string[] {
  const target = options.targetArtifactType ?? "auto";
  const reserveVideo =
    options.providers.videoEnabled &&
    (target === "auto" || target === "clip" || options.mediaFocus === "video");
  const reservePodcast =
    options.providers.geminiEnabled &&
    (target === "auto" || target === "podcast" || options.mediaFocus === "podcast");

  const lines = [
    "0. ARTIFACT MIX PLAN: before generating artifacts, read",
    "   skills/plan-feed-mix/SKILL.md and write a compact selection plan to",
    `   ${options.artifactsDir}/mix-plan.md. This file is scratch evidence, not`,
    "   a published artifact. The plan must name the intended slots and explicit",
    "   skip reasons for any rich-media slot that does not land.",
    `   Run target: ${target}; publishable cap: ${options.targetArtifacts}; media focus: ${options.mediaFocus}.`,
  ];

  if (reserveVideo) {
    lines.push(
      "   VIDEO SLOT: reserve one publishable slot for a clip attempt. Prefer",
      "   skills/make-cheap-video/SKILL.md with Gemini/Veo. Do not silently skip",
      "   video because text formats are easier; if no clip ships, write the",
      "   concrete skip reason in mix-plan.md and in the final summary.",
    );
  } else if (options.providers.videoEnabled) {
    lines.push(
      "   VIDEO SLOT: video is available, but this run has a different explicit",
      "   target. A clip is optional only if it strengthens the target proof.",
    );
  } else {
    lines.push(
      "   VIDEO SLOT: unavailable; note that AGENT_ENABLE_VIDEO=1 plus Gemini/Veo",
      "   or FAL_KEY is required before clip artifacts can publish.",
    );
  }

  if (reservePodcast) {
    lines.push(
      "   AUDIO SLOT: consider one podcast only when a sustained through-line",
      "   earns real Gemini TTS audio; do not create audio-less podcast shells.",
    );
  }

  lines.push(
    "   Fill remaining slots with the strongest feed mix: hot-take, article,",
    "   digest, insight-card, or person-brief as the corpus earns them. Preserve",
    "   exploration; reader interactions are weak backpressure, not settled taste.",
  );

  return lines;
}

/** Build the `claude -p` argv for the generation step (feed-run recipe, scoped). */
export function buildGenerationArgs(
  corpusDir: string,
  artifactsDir: string,
  transcripts: string[],
  options: {
    targetArtifactType?: ArtifactType;
    interactionBackpressure?: InteractionBackpressure;
  } = {},
): string[] {
  const targetArtifacts = config.targetArtifacts;
  const providers = generationProviderAvailability();
  const { geminiEnabled, videoEnabled } = providers;
  const mediaFocusStep = buildMediaFocusStep(config.mediaFocus, {
    ...providers,
  });
  const targetArtifactTypeStep = buildTargetArtifactTypeStep(options.targetArtifactType);
  const interactionBackpressureStep = buildInteractionBackpressureStep(
    options.interactionBackpressure,
  );
  const artifactMixPlanStep = buildArtifactMixPlanStep({
    targetArtifacts,
    artifactsDir,
    mediaFocus: config.mediaFocus,
    providers,
    ...(options.targetArtifactType ? { targetArtifactType: options.targetArtifactType } : {}),
  });
  const podcastStep = geminiEnabled
    ? [
        "   - make-podcast for a sustained through-line that benefits from a short",
        "     narrated audio artifact. Read skills/make-podcast/SKILL.md and follow",
        "     the full audio-producing path: digest + novelty/narrative-seed scan,",
        "     write script.md, verify quotes with --stamp, run synthesize.ts to",
        "     create episode.wav, then save with:",
        "     bun skills/make-podcast/scripts/save.ts <artifact.json> --audio",
        `     episode.wav --script script.md --out-dir ${artifactsDir}`,
        "     Do not create a podcast artifact unless it has real synthesized audio",
        "     and a saved `audio` file.",
      ]
    : [
        "   - PODCAST AUDIO SKIPPED: no Gemini provider is configured in this",
        "     generate environment. Do not create podcast artifacts or audio-less",
        "     podcast shells.",
      ];
  const imageStep = geminiEnabled
    ? [
        "   HERO IMAGES: after saving each publishable artifact, try to add a",
        "   real hero image with skills/illustrate-card when the artifact has a",
        "   concrete visual metaphor. Read skills/illustrate-card/SKILL.md, craft",
        "   a literal no-text editorial prompt, then run:",
        "   bun skills/illustrate-card/scripts/illustrate.ts --artifact-dir",
        "   <artifact-dir> --prompt \"...\" --skip-existing",
        "   Aim for one real hero image per published artifact, but keep quality",
        "   higher than coverage: if illustration fails, is abstract, contains text,",
        "   or is a placeholder, delete/strip it and leave hero_image unset.",
      ]
    : [
        "   HERO IMAGES SKIPPED: no Gemini image provider is configured in this",
        "   generate environment. Leave hero_image unset; do not create placeholder",
        "   or fallback graphics.",
      ];
  const clipProof = options.targetArtifactType === "clip";
  const videoStep = videoEnabled
    ? clipProof
      ? [
          "4. REQUIRED CLIP PROOF (make-cheap-video or make-clip): this run is",
          "   explicitly testing video generation. Prefer",
          "   skills/make-cheap-video/SKILL.md when Gemini/Veo is configured;",
          "   use skills/make-clip/SKILL.md when FAL is configured and continuity",
          "   needs the higher-control Seedance reference-video path.",
          "   Produce ONE contract-valid `clip` artifact with",
          "   `video` set to the mp4 file name and `hero_image` set to poster.png.",
          "   Use --out-dir " + artifactsDir + " when saving. Keep it simple:",
          "   a clear transcript-grounded metaphor is enough for this proof.",
          "5. CRITIC (no human gate): re-read each saved artifact as a skeptical editor",
        ]
      : [
          "4. EXPECTED CLIP SLOT (make-cheap-video or make-clip): because video",
          "   is enabled, the artifact mix plan reserves one clip attempt unless",
          "   another explicit target takes priority. Look for a clear transcript-",
          "   grounded visual metaphor or reversal worth spending video on. Prefer",
          "   the Gemini/Veo make-cheap-video path;",
          "   use make-clip for higher-control FAL/Seedance reference-video clips.",
          "   Produce at most ONE contract-valid `clip` artifact with `video` set to the",
          "   captioned mp4 file name and `hero_image` set to poster.png. Use",
          "   --out-dir " + artifactsDir + " when saving. If no clip ships, the",
          "   final summary and mix-plan.md must say exactly why.",
          "5. CRITIC (no human gate): re-read each saved artifact as a skeptical editor",
        ]
    : [
        "4. VIDEO SKIPPED: do NOT run make-cheap-video or make-clip in this run.",
        "   Video requires AGENT_ENABLE_VIDEO=1 plus Gemini/Veo or FAL_KEY.",
        "5. CRITIC (no human gate): re-read each saved artifact as a skeptical editor",
      ];
  const system = [
    "You are the distillery agent-run GENERATION agent, invoked headlessly.",
    "Distill the fetched Listen transcripts into feed artifacts. Judgment is",
    "yours; be ruthless about quality.",
    "",
    "RUN CONTEXT (paths authoritative; do not invent others):",
    `- repo root:      ${config.repoRoot}`,
    `- corpus dir:     ${corpusDir}`,
    `- artifacts to:   ${artifactsDir}`,
    `- target publishable Feed artifacts: ${targetArtifacts}`,
    `- media focus:    ${config.mediaFocus}`,
    "- transcripts:",
    ...transcripts.map((t) => `    ${t}`),
    "",
    ...mediaFocusStep,
    "",
    ...targetArtifactTypeStep,
    "",
    ...interactionBackpressureStep,
    "",
    ...artifactMixPlanStep,
    "",
    "DO, in order, from the repo root. Read each skill's SKILL.md first.",
    "Every save MUST use the flag  --out-dir " + artifactsDir + "  (load-bearing:",
    "the harness publishes ONLY what lands under that dir — a save without that",
    "flag goes to the repo default and is NOT published).",
    "1. Read the transcript files listed above.",
    `2. PUBLISHABLE FEED ARTIFACTS FIRST: aim for up to ${targetArtifacts}`,
    "   publishable internal artifacts before any outward draft. Quality is the",
    "   gate: fewer than the target is correct when the material does not earn",
    "   more. In media-focus runs, try the requested rich-media format first",
    "   only if it clears that skill's own novelty/craft bar. Use these skills:",
    "   - hot-take for compact, quote-anchored internal takes that can fill the",
    "     Feed quickly. Save with skills/hot-take/scripts/save.ts.",
    "   - write-article for the strongest through-line or narrative.",
    ...podcastStep,
    "   - extract-insights for compact non-obvious claims/decisions.",
    "   - person-brief only when a recurring person is salient and every claim is",
    "     grounded. Skip it if identity/role evidence is thin.",
    "   Every publishable artifact must be internal/feed-safe, contract-valid,",
    "   have verified quotes where the type requires them, and save under the",
    "   artifacts dir. Example article save:",
    "   bun skills/write-article/scripts/save.ts <artifact.json> " +
      `--out-dir ${artifactsDir}`,
    ...imageStep,
    "   This step is the primary deliverable because the Feed only shows",
    "   publishable internal artifacts; do not spend the run only on",
    "   approval-held drafts.",
    "3. OPTIONAL OUTWARD DRAFT (banger-extractor → social-post): only after the",
    `   publishable set is complete or clearly capped below ${targetArtifacts} by`,
    "   quality, run survey.ts on the transcripts → pick the single most",
    "   non-obvious EARNED SECRET actually said → climb the abstraction ladder +",
    "   4-question safety test → scrub-check → verify-quotes --stamp →",
    "   bun skills/banger-extractor/scripts/save.ts <artifact.json> " +
      `--out-dir ${artifactsDir}`,
    "   Zero is valid. Social posts are held for approval and will not fill Feed.",
    ...videoStep,
    "   AND a security reviewer — non-obvious value, leak-safe, no AI-slop, every",
    "   claim anchored to a VERIFIED verbatim quote. DELETE (rm -rf its dir under",
    `   ${artifactsDir}) any artifact that fails. Survivors stay.`,
    "",
    "CONSTRAINTS:",
    `- Save artifacts ONLY under ${artifactsDir} (via --out-dir above).`,
    "- Do NOT publish to TinyCloud — the harness publishes survivors after you.",
    "- Do NOT run any `tc` command — you have no delegation in this step.",
    "- Anchor every claim to a verbatim transcript quote.",
    `When finished, print: SAVED <n> artifacts under ${artifactsDir}, then stop.`,
  ].join("\n");

  const userLead =
    clipProof && videoEnabled
      ? `Distill the ${transcripts.length} transcript(s) in ${corpusDir} into one ` +
        `required video clip proof first, then optional supporting Feed artifacts, `
      : `Distill the ${transcripts.length} transcript(s) in ${corpusDir} into up to ` +
        `${targetArtifacts} publishable internal artifacts for the Feed, then optionally one ` +
        `approval-held social-post draft` +
        `${videoEnabled && !options.targetArtifactType ? ", with one reserved clip attempt" : ""}, `;
  const user =
    userLead +
    `save the survivors under ${artifactsDir} (do NOT publish), ` +
    `then print a one-line summary.`;

  // TOOL POSTURE (defense-in-depth — see the run() "generate" doc for the honest
  // threat model). In headless `claude -p`, --allowedTools does NOT make Bash
  // exclusive (general Bash runs by default), so:
  //  - --allowedTools: AUTO-APPROVES exactly the workflow tools (file ops +
  //    `Bash(bun:*)` to run skill scripts + `Bash(rm:*)` for the critic's
  //    artifact deletes) so headless runs don't hang waiting on approval.
  //  - --disallowedTools: HARD-BLOCKS the concrete escape/exfil vectors an
  //    injection reaches for — `tc`, network tools (curl/wget/nc/ssh/scp),
  //    keychain/env readers (security/env/printenv), WebFetch/WebSearch, plus a
  //    path-scoped Read/Glob/Grep deny of the agent state dir (best-effort).
  //
  // CREDENTIAL REACH (the fix for the add-dir finding): the agent state dir
  // (api-token / agent-key.json / delegation.json / tc-home) lives OUTSIDE repoRoot
  // (config.ts default ~/.tinycloud-agent), and the run scratch lives in a SEPARATE
  // root (config.runsDir, default ~/.tinycloud-agent-runs) — so we can --add-dir
  // the run's corpus + artifacts (+ the skills dir) while the wholesale
  // Read/Glob/Grep deny of agentStateDir has NO overlap with any granted dir. We
  // DO NOT --add-dir repoRoot; cwd stays repoRoot so `bun skills/...` resolves
  // (repo SOURCE readable, non-secret). The credential dir is under neither cwd
  // nor any --add-dir.
  //
  // HONEST CAVEAT: claude's Read tool in -p mode can still open arbitrary ABSOLUTE
  // paths, and `bun -e <js>` (bun is required + turing-complete) can read any file
  // this process can — so the denylist + out-of-repo state RAISE THE BAR and close
  // the reported add-dir vector, but do NOT fully sandbox the filesystem. Real
  // confinement (separate uid / container / TEE) is the phase-2 (Phala) hardening.
  // --no-session-persistence keeps the untrusted transcript out of ~/.claude.
  const allowedTools = ["Read", "Write", "Edit", "Glob", "Grep", "Bash(bun:*)", "Bash(rm:*)"].join(
    " ",
  );
  const stateGlob = `${config.agentStateDir}/**`;
  const disallowedTools = [
    "Bash(tc:*)",
    "Bash(curl:*)",
    "Bash(wget:*)",
    "Bash(nc:*)",
    "Bash(ssh:*)",
    "Bash(scp:*)",
    "Bash(security:*)",
    "Bash(env:*)",
    "Bash(printenv:*)",
    "WebFetch",
    "WebSearch",
    `Read(${stateGlob})`,
    `Glob(${stateGlob})`,
    `Grep(${stateGlob})`,
  ].join(" ");

  const skillsDir = join(config.repoRoot, "skills");

  return [
    "-p",
    user,
    "--system-prompt",
    system,
    "--model",
    config.genModel,
    "--allowedTools",
    allowedTools,
    "--disallowedTools",
    disallowedTools,
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--add-dir",
    skillsDir,
    "--add-dir",
    corpusDir,
    "--add-dir",
    artifactsDir,
  ];
}

/** Markdown corpus files listen-read wrote (absolute paths). Empty if none. */
async function listCorpus(corpusDir: string): Promise<string[]> {
  try {
    const entries = await readdir(corpusDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => join(corpusDir, e.name));
  } catch {
    return [];
  }
}

/** artifacts/<type>/<slug>/ dirs that hold an artifact.json. */
async function listArtifactDirs(artifactsDir: string): Promise<string[]> {
  const out: string[] = [];
  let types: string[];
  try {
    types = (await readdir(artifactsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const type of types) {
    const typeDir = join(artifactsDir, type);
    let slugs: string[];
    try {
      slugs = (await readdir(typeDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const dir = join(typeDir, slug);
      try {
        await readFile(join(dir, "artifact.json"), "utf8");
        out.push(dir);
      } catch {
        // not a real artifact dir
      }
    }
  }
  return out;
}

interface ArtifactRoute {
  dir: string;
  type: string;
  slug: string;
  audience?: string;
  approval_status?: string;
  publish: boolean;
  reason?: string;
  mediaWarnings?: string[];
}

interface ReadArtifactRouteOptions {
  preflightMedia?: boolean;
}

interface ArtifactMediaPreflight {
  warnings: string[];
  blockReason?: string;
}

function isArtifactType(type: string): type is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(type);
}

export function shouldPublishArtifact(input: {
  type: string;
  audience?: string;
  approval_status?: string;
}): { publish: boolean; reason?: string } {
  if (input.audience === "public" || input.audience === "investors") {
    return {
      publish: false,
      reason: `audience=${input.audience} requires approval surface`,
    };
  }
  if (
    input.approval_status === "pending" &&
    isArtifactType(input.type) &&
    isOutwardType(input.type) &&
    input.audience !== "internal"
  ) {
    return {
      publish: false,
      reason: `approval_status=pending for outward type ${input.type}`,
    };
  }
  return { publish: true };
}

export function summarizeArtifactRoutes(routes: Pick<ArtifactRoute, "type" | "slug" | "publish">[]): string {
  if (routes.length === 0) return "0 artifact(s)";
  const publishable = routes.filter((route) => route.publish);
  const held = routes.filter((route) => !route.publish);
  const labels = (items: Pick<ArtifactRoute, "type" | "slug">[]) =>
    items
      .slice(0, 4)
      .map((route) => `${route.type}/${route.slug}`)
      .join(", ");
  const parts = [`${routes.length} artifact(s)`, `${publishable.length} publishable`];
  if (publishable.length > 0) parts.push(`[${labels(publishable)}${publishable.length > 4 ? ", ..." : ""}]`);
  parts.push(`${held.length} held`);
  if (held.length > 0) parts.push(`[${labels(held)}${held.length > 4 ? ", ..." : ""}]`);
  return parts.join(" ");
}

export interface ArtifactTreeSummary {
  fileCount: number;
  totalBytes: number;
  latestPath?: string;
  latestMtimeMs?: number;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export function formatHeartbeatInfo(info: RunHeartbeatInfo): string {
  const pid = info.pid ? `pid=${info.pid}` : "pid=unknown";
  return `${pid} elapsed=${formatDuration(info.elapsedMs)} stdout=${info.stdoutBytes}B stderr=${info.stderrBytes}B`;
}

export function formatArtifactTreeSummary(summary: ArtifactTreeSummary, nowMs = Date.now()): string {
  if (summary.fileCount === 0) return "files=0";
  const latest = summary.latestPath ? ` latest=${summary.latestPath}` : "";
  const age =
    typeof summary.latestMtimeMs === "number"
      ? ` latest_age=${formatDuration(Math.max(0, nowMs - summary.latestMtimeMs))}`
      : "";
  return `files=${summary.fileCount} bytes=${summary.totalBytes}${latest}${age}`;
}

export async function summarizeArtifactTree(root: string, nowMs = Date.now()): Promise<string> {
  const summary: ArtifactTreeSummary = {
    fileCount: 0,
    totalBytes: 0,
  };

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let s;
      try {
        s = await stat(path);
      } catch {
        continue;
      }
      summary.fileCount += 1;
      summary.totalBytes += s.size;
      if (summary.latestMtimeMs === undefined || s.mtimeMs > summary.latestMtimeMs) {
        summary.latestMtimeMs = s.mtimeMs;
        summary.latestPath = relative(root, path) || entry.name;
      }
    }
  }

  await walk(root);
  return formatArtifactTreeSummary(summary, nowMs);
}

export function boundedProcessOutput(label: "stdout" | "stderr", text: string, maxChars = 900): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/).slice(-8).join("\n").trim();
  const tail = lines.length > maxChars ? `...${lines.slice(-maxChars)}` : lines;
  return `${label} tail: ${tail}`;
}

async function readArtifactRoute(
  dir: string,
  options: ReadArtifactRouteOptions = {},
): Promise<ArtifactRoute | null> {
  try {
    const artifact = JSON.parse(await readFile(join(dir, "artifact.json"), "utf8")) as {
      type?: unknown;
      slug?: unknown;
      audience?: unknown;
      approval_status?: unknown;
      hero_image?: unknown;
    } & Record<string, unknown>;
    const media = options.preflightMedia
      ? await preflightArtifactMediaForPublish(dir, artifact)
      : { warnings: [] };
    const fallback = await readArtifactRef(dir);
    const type =
      typeof artifact.type === "string" ? artifact.type : fallback?.type ?? "unknown";
    const slug =
      typeof artifact.slug === "string" ? artifact.slug : fallback?.slug ?? "unknown";
    const audience =
      typeof artifact.audience === "string" ? artifact.audience : undefined;
    const approval_status =
      typeof artifact.approval_status === "string"
        ? artifact.approval_status
        : undefined;
    const decision = shouldPublishArtifact({ type, audience, approval_status });
    return {
      dir,
      type,
      slug,
      audience,
      approval_status,
      publish: decision.publish && !media.blockReason,
      reason: decision.reason ?? media.blockReason,
      mediaWarnings: media.warnings,
    };
  } catch {
    return null;
  }
}

export async function sanitizeArtifactMediaForPublish(
  dir: string,
  artifact: Record<string, unknown>,
): Promise<string[]> {
  return (await preflightArtifactMediaForPublish(dir, artifact)).warnings;
}

export async function preflightArtifactMediaForPublish(
  dir: string,
  artifact: Record<string, unknown>,
): Promise<ArtifactMediaPreflight> {
  const warnings: string[] = [];
  const type = typeof artifact.type === "string" ? artifact.type : "unknown";
  let changed = false;
  let blockReason: string | undefined;

  const stripField = (field: "hero_image" | "audio" | "video", reason: string) => {
    delete artifact[field];
    changed = true;
    warnings.push(`${field} stripped: ${reason}`);
  };

  const blockRequired = (field: "audio" | "video", reason: string) => {
    blockReason ??= `${field} required for ${type} but ${reason}`;
    warnings.push(`${field} invalid: ${reason}`);
  };

  const checkOptional = async (
    field: "hero_image" | "audio" | "video",
    validate: (name: string, bytes: Uint8Array) => boolean,
    label: string,
  ) => {
    if (!Object.prototype.hasOwnProperty.call(artifact, field)) return;
    const value = artifact[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      stripField(field, "empty or non-string value");
      return;
    }
    const unsafeReason = unsafeMediaFileName(value);
    if (unsafeReason) {
      stripField(field, unsafeReason);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(dir, value)));
    } catch {
      stripField(field, `missing file ${JSON.stringify(value)}`);
      return;
    }
    if (!validate(value, bytes)) {
      stripField(field, `unsupported or invalid ${label} bytes ${JSON.stringify(value)}`);
    }
  };

  const checkRequired = async (
    field: "audio" | "video",
    validate: (name: string, bytes: Uint8Array) => boolean,
    label: string,
  ) => {
    const value = artifact[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      blockRequired(field, "the field is missing or empty");
      return;
    }
    const unsafeReason = unsafeMediaFileName(value);
    if (unsafeReason) {
      blockRequired(field, unsafeReason);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(dir, value)));
    } catch {
      blockRequired(field, `missing file ${JSON.stringify(value)}`);
      return;
    }
    if (!validate(value, bytes)) {
      blockRequired(field, `unsupported or invalid ${label} bytes ${JSON.stringify(value)}`);
    }
  };

  await checkOptional("hero_image", isSupportedImage, "image");
  if (type === "podcast") {
    await checkRequired("audio", isSupportedAudio, "audio");
  } else {
    await checkOptional("audio", isSupportedAudio, "audio");
  }
  if (type === "clip") {
    await checkRequired("video", isSupportedVideo, "video");
  } else {
    await checkOptional("video", isSupportedVideo, "video");
  }

  if (changed) {
    await writeFile(join(dir, "artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  }
  return { warnings, blockReason };
}

function unsafeMediaFileName(name: string): string | null {
  if (name !== name.trim()) return `unsafe media file name ${JSON.stringify(name)}`;
  if (
    isAbsolute(name) ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".." ||
    basename(name) !== name
  ) {
    return `unsafe media file name ${JSON.stringify(name)}`;
  }
  return null;
}

function isSupportedImage(name: string, bytes: Uint8Array): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "png") {
    return (
      bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (ext === "jpg" || ext === "jpeg") {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
  }
  if (ext === "webp") {
    return (
      bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    );
  }
  if (ext === "gif") {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    return bytes.length >= 10 && (header === "GIF87a" || header === "GIF89a");
  }
  return false;
}

function isSupportedAudio(name: string, bytes: Uint8Array): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "wav") {
    return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE";
  }
  if (ext === "mp3") {
    return (
      bytes.length >= 3 &&
      (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
    );
  }
  if (ext === "m4a" || ext === "mp4") {
    return isIsoBaseMedia(bytes);
  }
  if (ext === "ogg") {
    return bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS";
  }
  return false;
}

function isSupportedVideo(name: string, bytes: Uint8Array): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "mp4" || ext === "mov") {
    return isIsoBaseMedia(bytes);
  }
  if (ext === "webm") {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    );
  }
  return false;
}

function isIsoBaseMedia(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp";
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

export async function listArtifactRoutes(
  artifactsDir: string,
  options: ReadArtifactRouteOptions = {},
): Promise<ArtifactRoute[]> {
  const dirs = await listArtifactDirs(artifactsDir);
  const routes: ArtifactRoute[] = [];
  for (const dir of dirs) {
    const route = await readArtifactRoute(dir, options);
    if (route) routes.push(route);
  }
  return routes;
}

export function formatMediaSummary(ref: PublishedRef): string {
  const media = ref.media;
  if (!media) return "";
  const parts = [
    media.heroImage ? "image" : null,
    media.audio ? "audio" : null,
    media.video ? "video" : null,
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(", ")})` : " (no media)";
}

interface PublishJsonResult {
  type?: unknown;
  slug?: unknown;
  heroKey?: unknown;
  audioKey?: unknown;
  videoKey?: unknown;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function publishedRefFromPublishStdout(stdout: string, fallback: PublishedRef): PublishedRef {
  try {
    const parsed = JSON.parse(stdout.trim()) as PublishJsonResult;
    return {
      type: hasNonEmptyString(parsed.type) ? String(parsed.type) : fallback.type,
      slug: hasNonEmptyString(parsed.slug) ? String(parsed.slug) : fallback.slug,
      media: {
        heroImage: hasNonEmptyString(parsed.heroKey),
        audio: hasNonEmptyString(parsed.audioKey),
        video: hasNonEmptyString(parsed.videoKey),
      },
    };
  } catch {
    return fallback;
  }
}

/** Read artifact identity + media presence off an artifact dir for published[]. */
async function readArtifactRef(dir: string): Promise<PublishedRef | null> {
  try {
    const raw = await readFile(join(dir, "artifact.json"), "utf8");
    const a = JSON.parse(raw) as {
      type?: string;
      slug?: string;
      hero_image?: unknown;
      audio?: unknown;
      video?: unknown;
    };
    if (typeof a.type === "string" && typeof a.slug === "string") {
      return {
        type: a.type,
        slug: a.slug,
        media: {
          heroImage: typeof a.hero_image === "string" && a.hero_image.trim().length > 0,
          audio: typeof a.audio === "string" && a.audio.trim().length > 0,
          video: typeof a.video === "string" && a.video.trim().length > 0,
        },
      };
    }
  } catch {
    // fall through
  }
  // Fall back to the dir layout artifacts/<type>/<slug>/.
  const parts = dir.split("/");
  const slug = parts.at(-1);
  const type = parts.at(-2);
  if (type && slug) return { type, slug };
  return null;
}

/** Best-effort cleanup of a run's scratch corpus/ + artifacts/ (called post-run,
 *  on success AND error). The run's status.json is left in place for polling. */
export async function cleanupRunScratch(runId: string): Promise<void> {
  for (const sub of ["corpus", "artifacts"]) {
    try {
      await rm(join(config.runsDir, runId, sub), { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
