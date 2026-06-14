// runner.ts — the run-under-delegation pipeline (MVP). Executes the artifact
// pipeline's four stages as DIRECT skill-script invocations (Smithers is
// authored in .smithers/workflows/agent-run.tsx but blocked by a 0.20.4↔0.22.0
// React-version skew — see that file), all scoped to the user's delegation:
//
//   bootstrap → listen-read → generate → publish
//
// HOW THE DELEGATION THREADS IN (the whole point): every spawn runs with
//   env HOME=<config.tcHome>   (so tc reads the sandbox profile, not the user's ~)
//   --profile <config.profileName> --space <delegation.spaceId>
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

/**
 * Run a command from the repo root, inheriting the server's env (Gemini key,
 * claude/bun on PATH).
 *
 * `home`:
 *  - "sandbox" (default) — HOME=config.tcHome so every `tc` the skill shells out
 *    to reads the SANDBOX delegated profile. Used for the tc-backed stages
 *    (bootstrap, listen-read, publish): they run as the delegator.
 *  - "real" — leave HOME untouched. Used ONLY for the generate stage, which
 *    spawns `claude` (whose credentials live in the real ~/.claude) and writes
 *    artifact files LOCALLY (no `tc`, no delegation). Overriding HOME here would
 *    break claude auth ("Not logged in"); generate touches no delegated state.
 */
function run(cmd: string, args: string[], home: "sandbox" | "real" = "sandbox"): Promise<SpawnResult> {
  const env = home === "sandbox" ? { ...process.env, HOME: config.tcHome } : { ...process.env };
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

// Every skill runs under the delegated profile via the SANDBOX DEFAULT PROFILE:
// writeGlobalConfig set config.json's defaultProfile to config.profileName, and
// HOME points tc at that sandbox — so `tc` (no --profile) IS the delegate. We
// therefore only ever pass --space (the user's delegated space). bootstrap-
// schema + publish reject an unknown --profile, so NOT passing it is required;
// listen-read accepts it but the default suffices, keeping all three uniform.

const SKILLS = {
  bootstrap: "skills/tc-publish/scripts/bootstrap-schema.ts",
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

  // 1. BOOTSTRAP — create the user's three artifact DBs (idempotent). The node
  //    rejects CREATE INDEX; bootstrap-schema treats that as expected.
  step("bootstrap: ensuring artifact schema on the user's space");
  const boot = await run("bun", [SKILLS.bootstrap, "--space", space]);
  if (boot.code !== 0) {
    throw new Error(
      `bootstrap failed (exit ${boot.code}): ${boot.stderr.slice(-800) || boot.stdout.slice(-800)}`,
    );
  }

  // 2. LISTEN-READ — pull the user's transcripts into a per-run corpus. EMPTY
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

  // 3. GENERATE — headless claude over the corpus → tweet + article into the
  //    per-run artifacts dir. Mirrors harness/feed-run's run-generation recipe.
  step("generate: distilling tweet + article from the corpus");
  // REAL HOME: claude reads ~/.claude credentials; generate writes artifact
  // files locally (no tc, no delegation) so the sandbox HOME must NOT apply.
  const gen = await run("claude", buildGenerationArgs(corpusDir, artifactsDir, transcripts), "real");
  if (gen.code !== 0) {
    throw new Error(`generate failed (exit ${gen.code}): ${gen.stderr.slice(-800) || gen.stdout.slice(-800)}`);
  }

  // 4. PUBLISH — each generated artifact to the user's xyz.tinycloud.artifacts
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

  return ["-p", user, "--system-prompt", system, "--model", config.genModel];
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

/** Best-effort cleanup of a run's scratch corpus/artifacts (called post-run). */
export async function cleanupRunScratch(runId: string): Promise<void> {
  try {
    await rm(join(config.runsDir, runId, "corpus"), { recursive: true, force: true });
  } catch {
    // best effort
  }
}
