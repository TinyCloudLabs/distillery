#!/usr/bin/env bun
// full-media-smoke.ts — one controlled Smithers/operator proof of the three
// spend-bearing rich-media paths: make-clip video, make-podcast audio, and
// write-article + illustrate-card hero image. It can stop at local artifacts
// or publish those artifacts through the delegated Artifactory agent profile.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "../harness/agent/src/config.ts";
import { AgentSession } from "../harness/agent/src/session.ts";
import {
  createPipelineContext,
  prepareRunScratch,
  runPublishStage,
  type RunState,
} from "../harness/agent/src/runner.ts";
import {
  acquireRunLock,
  createRun,
  createRunId,
  releaseRunLock,
  summarizePublishedMedia,
  writeRun,
} from "../harness/agent/src/runs.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dir, "..");

type Duration = "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "14" | "15" | "auto";
type Resolution = "480p" | "720p" | "1080p";
type Aspect = "1:1" | "9:16" | "16:9";
type Stage = "clip" | "podcast" | "article";

interface Args {
  publish: boolean;
  outDir?: string;
  publishExistingDir?: string;
  only?: Stage;
  runLabel?: string;
  report?: string;
  envFile: string;
  duration: Duration;
  resolution: Resolution;
  aspect: Aspect;
  keepScratch: boolean;
}

interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
}

interface ArtifactResult {
  kind: "clip" | "podcast" | "article";
  dir: string;
  jsonPath: string;
  media: string[];
  commandNotes: string[];
}

function usage(): never {
  console.error(
      "usage: bun scripts/full-media-smoke.ts [--publish] [--out-dir DIR]\n" +
      "       [--publish-existing DIR]\n" +
      "       [--only clip|podcast|article] [--run-label LABEL]\n" +
      "       [--report FILE] [--env-file FILE] [--duration 4..15|auto]\n" +
      "       [--resolution 480p|720p|1080p] [--aspect 1:1|9:16|16:9]\n" +
      "       [--keep-scratch]",
  );
  process.exit(2);
}

function expandHome(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  return path === "~" ? home : path.replace(/^~\//, `${home}/`);
}

function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match?.[1]) continue;
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function loadEnv(path: string): Record<string, string> {
  const expanded = expandHome(path);
  if (!existsSync(expanded)) return {};
  return parseEnvText(readFileSync(expanded, "utf8"));
}

function parseArgs(argv: string[]): Args {
  const validDurations = new Set(["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "auto"]);
  const validResolutions = new Set(["480p", "720p", "1080p"]);
  const validAspects = new Set(["1:1", "9:16", "16:9"]);
  const validStages = new Set(["clip", "podcast", "article"]);
  const args: Args = {
    publish: false,
    envFile: process.env.DEV_DISTILLERY_ENV ?? "~/development.nosync/distillery/.env",
    duration: "4",
    resolution: "480p",
    aspect: "1:1",
    keepScratch: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--publish") args.publish = true;
    else if (arg === "--keep-scratch") args.keepScratch = true;
    else if (arg === "--out-dir") {
      args.outDir = argv[++i];
      if (!args.outDir) usage();
    } else if (arg === "--report") {
      args.report = argv[++i];
      if (!args.report) usage();
    } else if (arg === "--publish-existing") {
      args.publishExistingDir = argv[++i];
      if (!args.publishExistingDir) usage();
    } else if (arg === "--only") {
      const value = argv[++i];
      if (!validStages.has(value ?? "")) usage();
      args.only = value as Stage;
    } else if (arg === "--run-label") {
      args.runLabel = argv[++i];
      if (!args.runLabel) usage();
    } else if (arg === "--env-file") {
      args.envFile = argv[++i] ?? usage();
    } else if (arg === "--duration") {
      const value = argv[++i];
      if (!validDurations.has(value ?? "")) usage();
      args.duration = value as Duration;
    } else if (arg === "--resolution") {
      const value = argv[++i];
      if (!validResolutions.has(value ?? "")) usage();
      args.resolution = value as Resolution;
    } else if (arg === "--aspect") {
      const value = argv[++i];
      if (!validAspects.has(value ?? "")) usage();
      args.aspect = value as Aspect;
    } else usage();
  }
  return args;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function artifactBase(runLabel: string, kind: string): Record<string, unknown> {
  return {
    headline: `Smithers ${kind} proof ${runLabel}`,
    tags: ["smithers", "smoke", "media-proof"],
    source_transcripts: ["smithers://full-media-generation-smoke"],
    generated_at: new Date().toISOString(),
    quality: {
      critic_pass: true,
      quotes_verified: true,
      notes: "Controlled Smithers proof artifact. Synthetic source marker; validates generation, media attachment, and optional TinyCloud publish.",
    },
  };
}

function articleBody(): string {
  return [
    "This smoke article exists to prove the editorial-with-image path as a concrete system behavior, not to make a claim about a meeting transcript. The important fact is structural: Smithers can call a portable Artifactory skill, persist a contract-valid article, attach generated image media, and hand the result to the same publish path the Feed consumes.",
    "The test deliberately stays small. It does not ask a reasoning agent to decide which transcript deserves an article. It writes a clearly labeled proof artifact, then runs the same `write-article` save script that normal editorial output uses. That means the card has the expected JSON shape, body markdown, tags, source markers, quality block, generated timestamp, and stable artifact directory.",
    "After the article is saved, the image step runs independently through `illustrate-card`. That distinction matters for the migration: image generation is packaging on top of an existing artifact, not a hidden side effect inside the editorial writer. If the image provider fails, the failure points at the packaging skill. If the article contract fails, the failure points at the editorial save script. Those are different operational problems and should be visible separately.",
    "When publishing is enabled, this artifact travels through the delegated Artifactory agent path and lands in TinyCloud next to the podcast and video proof artifacts. The Feed should then show one article-style artifact with a real hero image, one podcast artifact with playable audio, and one clip artifact with video media. Seeing all three together proves the current Smithers, Artifactory, TinyCloud, and Feed wiring can carry more than plain text.",
  ].join("\n\n");
}

async function runBun(args: string[], env: Record<string, string>, timeoutMs: number): Promise<CommandResult> {
  const command = `bun ${args.join(" ")}`;
  const res = await execFileAsync("bun", args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    timeout: timeoutMs,
    maxBuffer: 12 * 1024 * 1024,
  });
  return { command, stdout: res.stdout, stderr: res.stderr };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

function savedPathFromOutput(output: string): string {
  const match = /^Saved:\s+(.+)$/m.exec(output);
  if (!match?.[1]) throw new Error(`could not find saved artifact path in output:\n${output.slice(-1000)}`);
  return resolve(repoRoot, match[1].replace(/\s+\(.+$/, "").trim());
}

function artifactDirFromJson(jsonPath: string): string {
  return jsonPath.replace(/\/artifact\.json$/, "");
}

async function generateClip(outDir: string, runLabel: string, envFile: string, opts: Args): Promise<ArtifactResult> {
  const workDir = resolve(outDir, "_work", "clip");
  await mkdir(workDir, { recursive: true });
  const video = await runBun(
    [
      "skills/make-clip/scripts/video-smoke.ts",
      "--out-dir",
      workDir,
      "--env-file",
      envFile,
      "--duration",
      opts.duration,
      "--resolution",
      opts.resolution,
      "--aspect",
      opts.aspect,
      "--keep",
    ],
    {},
    35 * 60_000,
  );
  const report = JSON.parse(await readFile(resolve(workDir, "video-smoke-report.json"), "utf8")) as { out?: string; requestId?: string };
  if (!report.out) throw new Error("video-smoke succeeded without an output path");

  const artifactPath = resolve(workDir, "clip-artifact.json");
  await writeJson(artifactPath, {
    ...artifactBase(runLabel, "video"),
    type: "clip",
    body: "A controlled Smithers proof clip generated through the make-clip video path and saved as Feed-readable video media.",
    quote: "Video generation is wired all the way to a publishable artifact.",
    attribution: "Smithers media smoke",
    generation_model: "seedance-2.0",
  });
  const saved = await runBun(
    [
      "skills/make-clip/scripts/save.ts",
      artifactPath,
      "--video",
      report.out,
      "--out-dir",
      outDir,
    ],
    {},
    3 * 60_000,
  );
  const jsonPath = savedPathFromOutput(saved.stdout);
  return {
    kind: "clip",
    dir: artifactDirFromJson(jsonPath),
    jsonPath,
    media: [basename(report.out), "poster.png"],
    commandNotes: [video.command, saved.command, report.requestId ? `fal request ${report.requestId}` : "fal request unknown"],
  };
}

async function generatePodcast(outDir: string, runLabel: string, providerEnv: Record<string, string>): Promise<ArtifactResult> {
  const workDir = resolve(outDir, "_work", "podcast");
  await mkdir(workDir, { recursive: true });
  const scriptPath = resolve(workDir, "script.md");
  await writeFile(
    scriptPath,
    [
      "Avery: This is a Smithers media proof. The podcast skill is producing real audio, not a placeholder.",
      "Blake: The artifact will save with an episode script and a compressed web audio file, then the Feed can render the podcast controls.",
      "Avery: The goal is boring evidence: one delegated publish path carrying text, image, audio, and video.",
    ].join("\n"),
  );
  const wavPath = resolve(workDir, "episode.wav");
  const synth = await runBun(
    [
      "skills/make-podcast/scripts/synthesize.ts",
      scriptPath,
      "--speaker",
      "Avery=Kore",
      "--speaker",
      "Blake=Puck",
      "--out",
      wavPath,
      "--smoke",
    ],
    providerEnv,
    8 * 60_000,
  );
  const artifactPath = resolve(workDir, "podcast-artifact.json");
  await writeJson(artifactPath, {
    ...artifactBase(runLabel, "podcast"),
    type: "podcast",
    body: "A short controlled Smithers proof episode with real Gemini TTS audio and the script saved beside the artifact.",
    quote: "The podcast skill is producing real audio, not a placeholder.",
    attribution: "Smithers media smoke",
    generation_model: "gemini-2.5-flash-preview-tts",
  });
  const saved = await runBun(
    [
      "skills/make-podcast/scripts/save.ts",
      artifactPath,
      "--audio",
      wavPath,
      "--script",
      scriptPath,
      "--out-dir",
      outDir,
    ],
    providerEnv,
    3 * 60_000,
  );
  const jsonPath = savedPathFromOutput(saved.stdout);
  return {
    kind: "podcast",
    dir: artifactDirFromJson(jsonPath),
    jsonPath,
    media: ["episode.wav", "episode.m4a", "script.md"],
    commandNotes: [synth.command, saved.command],
  };
}

async function generateArticle(outDir: string, runLabel: string, providerEnv: Record<string, string>): Promise<ArtifactResult> {
  const workDir = resolve(outDir, "_work", "article");
  await mkdir(workDir, { recursive: true });
  const artifactPath = resolve(workDir, "article-artifact.json");
  await writeJson(artifactPath, {
    ...artifactBase(runLabel, "editorial image"),
    type: "article",
    body: articleBody(),
    quote: "Seeing all three together proves the current wiring can carry more than plain text.",
    attribution: "Smithers media smoke",
    generation_model: "smithers-full-media-smoke",
  });
  const saved = await runBun(
    ["skills/write-article/scripts/save.ts", artifactPath, "--out-dir", outDir],
    providerEnv,
    3 * 60_000,
  );
  const jsonPath = savedPathFromOutput(saved.stdout);
  const dir = artifactDirFromJson(jsonPath);
  const promptPath = resolve(workDir, "image-prompt.txt");
  await writeFile(
    promptPath,
    [
      "Editorial hero image for a systems proof article.",
      "Show three clean media lanes converging into a minimal feed surface:",
      "a small video frame, an audio waveform, and an illustrated article image.",
      "No text, no logos, no browser chrome, crisp product-documentation style,",
      "balanced neutral background with a few precise accent colors.",
    ].join(" "),
  );
  const image = await runBun(
    [
      "skills/illustrate-card/scripts/illustrate.ts",
      "--artifact-dir",
      dir,
      "--prompt-file",
      promptPath,
      "--aspect",
      "16:9",
      "--note",
      "full-media-smoke hero image generated",
    ],
    providerEnv,
    8 * 60_000,
  );
  return {
    kind: "article",
    dir,
    jsonPath,
    media: ["body.md", "hero.png"],
    commandNotes: [saved.command, image.command],
  };
}

async function publishArtifacts(outDir: string): Promise<{
  runId: string;
  statusFile: string;
  published: RunState["published"];
  held: RunState["held"];
  media: ReturnType<typeof summarizePublishedMedia>;
  log: string[];
}> {
  const runId = createRunId();
  const lock = acquireRunLock(runId, "smithers-full-media-smoke");
  if (!lock.ok) throw new Error(lock.message);

  let state: RunState | undefined;
  try {
    state = createRun(runId);
    state.status = "running";
    state.log.push(`${new Date().toISOString()} full-media-smoke: publishing generated media artifacts`);
    writeRun(state);

    const session = await AgentSession.bootstrap();
    const active = session.getActive();
    if (!active) throw new Error("No active delegation found. Connect an agent from Feed or POST /agent/delegation first.");

    const ctx = createPipelineContext(active, state, writeRun);
    await prepareRunScratch(ctx);
    ctx.artifactsDir = outDir;
    await runPublishStage(ctx);
    state.status = "done";
    state.finishedAt = Date.now();
    writeRun(state);
    return {
      runId,
      statusFile: resolve(config.runsDir, runId, "status.json"),
      published: state.published,
      held: state.held ?? [],
      media: summarizePublishedMedia(state.published),
      log: state.log,
    };
  } catch (err) {
    if (state) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      state.finishedAt = Date.now();
      state.log.push(`${new Date().toISOString()} ERROR: ${state.error}`);
      writeRun(state);
    }
    throw err;
  } finally {
    releaseRunLock(runId);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runLabel = args.runLabel ?? timestampSlug();
  const outDir = args.publishExistingDir
    ? resolve(args.publishExistingDir)
    : args.outDir
      ? resolve(args.outDir)
      : resolve(".smithers/reports", `full-media-smoke-${runLabel}`);
  const reportPath = args.report
    ? resolve(args.report)
    : resolve(outDir, "full-media-smoke-report.json");
  const providerEnv = loadEnv(args.envFile);
  await mkdir(outDir, { recursive: true });

  const artifacts: ArtifactResult[] = [];
  let publish:
    | Awaited<ReturnType<typeof publishArtifacts>>
    | { skipped: true; reason: string } = { skipped: true, reason: "--publish not set" };

  try {
    if (args.publishExistingDir) {
      args.publish = true;
    } else if (args.only === "clip") {
      artifacts.push(await generateClip(outDir, runLabel, args.envFile, args));
    } else if (args.only === "podcast") {
      artifacts.push(await generatePodcast(outDir, runLabel, providerEnv));
    } else if (args.only === "article") {
      artifacts.push(await generateArticle(outDir, runLabel, providerEnv));
    } else {
      artifacts.push(await generateClip(outDir, runLabel, args.envFile, args));
      artifacts.push(await generatePodcast(outDir, runLabel, providerEnv));
      artifacts.push(await generateArticle(outDir, runLabel, providerEnv));
    }

    if (args.publish) {
      publish = await publishArtifacts(outDir);
    }

    const report = {
      ok: true,
      outDir,
      envFile: args.envFile,
      generatedAt: new Date().toISOString(),
      artifacts,
      publish,
    };
    await mkdir(resolve(reportPath, ".."), { recursive: true });
    await writeJson(reportPath, report);
    console.log(JSON.stringify({ ok: true, reportPath, outDir, publish }, null, 2));
  } catch (err) {
    const report = {
      ok: false,
      outDir,
      envFile: args.envFile,
      generatedAt: new Date().toISOString(),
      artifacts,
      publish,
      error: err instanceof Error ? err.message : String(err),
    };
    await mkdir(resolve(reportPath, ".."), { recursive: true });
    await writeJson(reportPath, report);
    console.error(JSON.stringify({ ok: false, reportPath, error: report.error }, null, 2));
    process.exit(1);
  }
}

await main();
