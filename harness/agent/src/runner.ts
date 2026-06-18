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

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.ts";
import type { ActiveDelegation } from "./session.ts";
import { classifyListenReadResult } from "./listen-read-outcome.ts";
import { ARTIFACT_TYPES, isOutwardType, type ArtifactType } from "../../../skills/_shared/lib/formats.ts";

export type RunStatus = "queued" | "running" | "done" | "error";

export interface PublishedRef {
  type: string;
  slug: string;
}

export interface RunState {
  run_id: string;
  status: RunStatus;
  published: PublishedRef[];
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

interface RunHooks {
  heartbeatMs?: number;
  onHeartbeat?: () => void | Promise<void>;
}

export interface PipelineContext {
  active: ActiveDelegation;
  state: RunState;
  onProgress: (s: RunState) => void;
  space: string;
  corpusDir: string;
  artifactsDir: string;
  step: (msg: string) => void;
}

export type ListenReadStageResult =
  | { kind: "ready"; transcripts: string[] }
  | { kind: "empty" };

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
    const child = spawn(cmd, args, {
      cwd: config.repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (hooks.onHeartbeat) {
      heartbeat = setInterval(() => {
        Promise.resolve(hooks.onHeartbeat?.()).catch(() => {
          // Best-effort status visibility; never fail the child for log writes.
        });
      }, hooks.heartbeatMs ?? 30_000);
    }
    let stdout = "";
    let stderr = "";
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
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? "", // real home — claude's keychain auth needs it
    PATH: generatePath(),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: process.env.TERM ?? "xterm-256color",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
  const ALLOW = [
    // (1) model-provider creds
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GEMINI_API_KEY",
    "GOOGLE_AI_API_KEY",
    "GOOGLE_API_KEY",
    "AGENT_GEN_MODEL",
    "AGENT_ENABLE_VIDEO",
    // (2) macOS keychain-session vars (so claude finds its login token)
    "USER",
    "LOGNAME",
    "__CF_USER_TEXT_ENCODING",
  ];
  for (const k of ALLOW) {
    const v = process.env[k];
    if (typeof v === "string" && v.length > 0) env[k] = v;
  }
  if (process.env.AGENT_ENABLE_VIDEO === "1" && process.env.FAL_KEY) {
    env.FAL_KEY = process.env.FAL_KEY;
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
): Promise<void> {
  const ctx = createPipelineContext(active, state, onProgress);

  state.status = "running";
  ctx.step("run started");

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
  ctx.step("listen-read: fetching the user's Listen transcripts");
  const read = await run("bun", [
    SKILLS.listenRead,
    "--out",
    ctx.corpusDir,
    "--count",
    String(config.transcriptCount),
    "--space",
    ctx.space,
  ]);

  const transcripts = await listCorpus(ctx.corpusDir);
  const readOutcome = classifyListenReadResult(read);
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
  ctx.step(`listen-read: ${transcripts.length} transcript(s) fetched`);
  return { kind: "ready", transcripts };
}

export async function runGenerateStage(
  ctx: PipelineContext,
  transcripts: string[],
): Promise<void> {
  // GENERATE — headless claude over the corpus → tweet + article into the per-run
  // artifacts dir. Mirrors harness/feed-run's run-generation recipe.
  ctx.step("generate: distilling tweet + article from the corpus");
  // SCRUBBED env + minimal HOME (only a ~/.claude symlink): claude reads its own
  // credentials and writes artifact files locally, but a prompt-injected
  // transcript can't reach ~/.tinycloud, the agent state, env secrets, or `tc`.
  const gen = await run(
    "claude",
    buildGenerationArgs(ctx.corpusDir, ctx.artifactsDir, transcripts),
    "generate",
    {
      heartbeatMs: 30_000,
      onHeartbeat: async () => {
        const count = (await listArtifactDirs(ctx.artifactsDir)).length;
        ctx.step(`generate: still running (${count} artifact dir(s) currently on disk)`);
      },
    },
  );
  if (gen.code !== 0) {
    throw new Error(`generate failed (exit ${gen.code}): ${gen.stderr.slice(-800) || gen.stdout.slice(-800)}`);
  }
}

export async function runPublishStage(ctx: PipelineContext): Promise<void> {
  // PUBLISH — each generated artifact to the user's xyz.tinycloud.artifacts
  // (KV media + SQL feed row, approval_status='approved'), under delegation.
  const artifactRoutes = await listArtifactRoutes(ctx.artifactsDir);
  const publishable = artifactRoutes.filter((route) => route.publish);
  const drafts = artifactRoutes.filter((route) => !route.publish);
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
    const pub = await run("bun", [SKILLS.publish, artifact.dir, "--space", ctx.active.spaceId]);
    if (pub.code !== 0) {
      throw new Error(
        `publish failed for ${artifact.dir} (exit ${pub.code}): ${pub.stderr.slice(-800) || pub.stdout.slice(-800)}`,
      );
    }
    const ref = await readArtifactRef(artifact.dir);
    if (ref) ctx.state.published.push(ref);
    ctx.step(`publish: ${ref ? `${ref.type}/${ref.slug}` : artifact.dir} published`);
  }
}

/** Build the `claude -p` argv for the generation step (feed-run recipe, scoped). */
function buildGenerationArgs(
  corpusDir: string,
  artifactsDir: string,
  transcripts: string[],
): string[] {
  const videoEnabled = process.env.AGENT_ENABLE_VIDEO === "1" && Boolean(process.env.FAL_KEY);
  const videoStep = videoEnabled
    ? [
        "4. OPTIONAL CLIP (make-clip): only if the corpus contains one unusually",
        "   visual, emotionally legible reversal worth spending video on. Read",
        "   skills/make-clip/SKILL.md and follow its speculative mode. Produce at",
        "   most ONE contract-valid `clip` artifact with `video` set to the",
        "   captioned mp4 file name and `hero_image` set to poster.png. Use",
        "   --out-dir " + artifactsDir + " when saving. Zero clips is valid and",
        "   preferred over a mediocre clip.",
        "5. CRITIC (no human gate): re-read each saved artifact as a skeptical editor",
      ]
    : [
        "4. VIDEO SKIPPED: do NOT run make-clip in this run. It requires",
        "   AGENT_ENABLE_VIDEO=1 and FAL_KEY because it is slower and spend-bearing.",
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
    "- transcripts:",
    ...transcripts.map((t) => `    ${t}`),
    "",
    "DO, in order, from the repo root. Read each skill's SKILL.md first.",
    "Every save MUST use the flag  --out-dir " + artifactsDir + "  (load-bearing:",
    "the harness publishes ONLY what lands under that dir — a save without that",
    "flag goes to the repo default and is NOT published).",
    "1. Read the transcript files listed above.",
    "2. TWEET (banger-extractor → social-post): run survey.ts on the transcripts →",
    "   pick the single most non-obvious EARNED SECRET actually said → climb the",
    "   abstraction ladder + 4-question safety test → scrub-check → verify-quotes",
    "   --stamp →  bun skills/banger-extractor/scripts/save.ts <artifact.json> " +
      `--out-dir ${artifactsDir}`,
    "   Aim for one; zero is valid ONLY if no line genuinely clears the bar.",
    "3. ARTICLE (write-article): draft a contract-valid article (non-empty body,",
    "   >=1 verified quote) → verify-quotes --stamp → leave hero_image unset",
    "   unless you successfully run illustrate-card/Gemini and have a real local",
    "   image file in the artifact dir. Do not create placeholder/fallback",
    "   graphics. Then: bun skills/write-article/scripts/save.ts <artifact.json> " +
      `--out-dir ${artifactsDir}`,
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

  const user =
    `Distill the ${transcripts.length} transcript(s) in ${corpusDir} into one tweet ` +
    `and one article${videoEnabled ? ", plus at most one excellent clip if justified" : ""}, ` +
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

async function readArtifactRoute(dir: string): Promise<ArtifactRoute | null> {
  try {
    const artifact = JSON.parse(await readFile(join(dir, "artifact.json"), "utf8")) as {
      type?: unknown;
      slug?: unknown;
      audience?: unknown;
      approval_status?: unknown;
      hero_image?: unknown;
    } & Record<string, unknown>;
    const mediaWarnings = await sanitizeArtifactMediaForPublish(dir, artifact);
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
      publish: decision.publish,
      reason: decision.reason,
      mediaWarnings,
    };
  } catch {
    return null;
  }
}

export async function sanitizeArtifactMediaForPublish(
  dir: string,
  artifact: Record<string, unknown>,
): Promise<string[]> {
  const warnings: string[] = [];
  if (!Object.prototype.hasOwnProperty.call(artifact, "hero_image")) {
    return warnings;
  }

  const stripHero = (reason: string) => {
    delete artifact.hero_image;
    warnings.push(`hero_image stripped: ${reason}`);
  };

  const hero = artifact.hero_image;
  if (typeof hero !== "string" || hero.trim().length === 0) {
    stripHero("empty or non-string value");
  } else {
    const unsafeReason = unsafeMediaFileName(hero);
    if (unsafeReason) {
      stripHero(unsafeReason);
    } else {
      let bytes: Uint8Array | undefined;
      try {
        bytes = new Uint8Array(await readFile(join(dir, hero)));
      } catch {
        stripHero(`missing file ${JSON.stringify(hero)}`);
      }
      if (bytes && !isSupportedImage(hero, bytes)) {
        stripHero(`unsupported or invalid image bytes ${JSON.stringify(hero)}`);
      }
    }
  }

  if (warnings.length > 0) {
    await writeFile(join(dir, "artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  }
  return warnings;
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

async function listArtifactRoutes(artifactsDir: string): Promise<ArtifactRoute[]> {
  const dirs = await listArtifactDirs(artifactsDir);
  const routes: ArtifactRoute[] = [];
  for (const dir of dirs) {
    const route = await readArtifactRoute(dir);
    if (route) routes.push(route);
  }
  return routes;
}

/** Read { type, slug } off an artifact dir for the published[] response. */
async function readArtifactRef(dir: string): Promise<PublishedRef | null> {
  try {
    const raw = await readFile(join(dir, "artifact.json"), "utf8");
    const a = JSON.parse(raw) as { type?: string; slug?: string };
    if (typeof a.type === "string" && typeof a.slug === "string") {
      return { type: a.type, slug: a.slug };
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
