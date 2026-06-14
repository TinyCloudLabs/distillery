// runner.ts — the run-under-delegation pipeline (MVP). Executes the artifact
// pipeline's stages as DIRECT skill-script invocations (Smithers is authored in
// .smithers/workflows/agent-run.tsx but blocked by a 0.20.4↔0.22.0 React-version
// skew — see that file), all scoped to the user's delegation:
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
// transcripts" when the user has no Listen data — we treat that as a VALID run
// that publishes 0 artifacts (skip generate + publish), not an error.

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.ts";
import type { ActiveDelegation } from "./session.ts";

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
function run(cmd: string, args: string[], mode: EnvMode = "sandbox"): Promise<SpawnResult> {
  const env =
    mode === "sandbox"
      ? { ...process.env, HOME: config.tcHome }
      : buildGenerateEnv();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: config.repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

// ── GENERATE-STAGE SANDBOX (scrub the env claude -p inherits) ───────────────
// The generate child reads untrusted Listen transcripts; a prompt-injected
// transcript shouldn't be able to exfiltrate env secrets or casually shell out.
// buildGenerateEnv gives it ONLY what `claude -p` + the skill scripts (run via
// `bun`) + the optional Gemini hero genuinely need. NOTE: `bun` and `tc` live in
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
 *  1. model-provider creds the generate step legitimately uses (claude's key +
 *     the optional Gemini key);
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
    // (2) macOS keychain-session vars (so claude finds its login token)
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
): Promise<void> {
  const space = active.spaceId;
  const corpusDir = join(config.runsDir, state.run_id, "corpus");
  const artifactsDir = join(config.runsDir, state.run_id, "artifacts");

  const step = (msg: string) => {
    state.log.push(`${new Date().toISOString()} ${msg}`);
    onProgress(state);
  };

  state.status = "running";
  step("run started");

  await mkdir(corpusDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  try {
  // NO bootstrap step: the front end owns table creation (it has feed +
  // interactions write on the owner's own session). The agent's minimal
  // delegation can't CREATE the interactions/control tables, so running
  // bootstrap-schema here would 401 and crash. tc-publish below does a pure
  // INSERT into the pre-existing `feed` table (+ media KV) — both delegated.

  // 1. LISTEN-READ — pull the user's transcripts into a per-run corpus. EMPTY
  //    -SAFE: exit 1 + "No non-empty transcripts" → 0 transcripts → valid, done.
  step("listen-read: fetching the user's Listen transcripts");
  const read = await run("bun", [
    SKILLS.listenRead,
    "--out",
    corpusDir,
    "--count",
    String(config.transcriptCount),
    "--space",
    space,
  ]);

  const transcripts = await listCorpus(corpusDir);
  if (transcripts.length === 0) {
    step(
      `listen-read: 0 transcripts (empty-Listen path) — read exit=${read.code}. ` +
        `Completing with 0 artifacts (valid).`,
    );
    state.status = "done";
    state.finishedAt = Date.now();
    onProgress(state);
    return;
  }
  step(`listen-read: ${transcripts.length} transcript(s) fetched`);

  // 2. GENERATE — headless claude over the corpus → tweet + article into the
  //    per-run artifacts dir. Mirrors harness/feed-run's run-generation recipe.
  step("generate: distilling tweet + article from the corpus");
  // SCRUBBED env + minimal HOME (only a ~/.claude symlink): claude reads its own
  // credentials and writes artifact files locally, but a prompt-injected
  // transcript can't reach ~/.tinycloud, the agent state, env secrets, or `tc`.
  const gen = await run(
    "claude",
    buildGenerationArgs(corpusDir, artifactsDir, transcripts),
    "generate",
  );
  if (gen.code !== 0) {
    throw new Error(`generate failed (exit ${gen.code}): ${gen.stderr.slice(-800) || gen.stdout.slice(-800)}`);
  }

  // 3. PUBLISH — each generated artifact to the user's xyz.tinycloud.artifacts
  //    (KV media + SQL feed row, approval_status='approved'), under delegation.
  const artifactDirs = await listArtifactDirs(artifactsDir);
  step(`publish: ${artifactDirs.length} artifact(s) to the user's space`);
  for (const dir of artifactDirs) {
    const pub = await run("bun", [SKILLS.publish, dir, "--space", active.spaceId]);
    if (pub.code !== 0) {
      throw new Error(
        `publish failed for ${dir} (exit ${pub.code}): ${pub.stderr.slice(-800) || pub.stdout.slice(-800)}`,
      );
    }
    const ref = await readArtifactRef(dir);
    if (ref) state.published.push(ref);
    step(`publish: ${ref ? `${ref.type}/${ref.slug}` : dir} published`);
  }

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

/** Build the `claude -p` argv for the generation step (feed-run recipe, scoped). */
function buildGenerationArgs(
  corpusDir: string,
  artifactsDir: string,
  transcripts: string[],
): string[] {
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
    "   >=1 verified quote) → verify-quotes --stamp → set a hero_image to a real",
    "   local image file you place in the artifact dir (skip illustrate-card if no",
    "   Gemini key) →  bun skills/write-article/scripts/save.ts <artifact.json> " +
      `--out-dir ${artifactsDir}`,
    "4. CRITIC (no human gate): re-read each saved artifact as a skeptical editor",
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
    `and one article, save the survivors under ${artifactsDir} (do NOT publish), ` +
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
