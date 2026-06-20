#!/usr/bin/env bun
// video-smoke.ts — direct, low-cost FAL/Seedance smoke for the make-clip video
// path. This intentionally bypasses Claude, transcript mining, and editorial
// quality gates. It proves storage upload + reference-to-video + MP4 download.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  FalError,
  generateVideo,
  isValidDuration,
  uploadToFalStorage,
  type AspectRatio,
  type VideoDuration,
  type VideoResolution,
} from "../../_shared/lib/fal.ts";

function usage(): never {
  console.error(
    "usage: bun skills/make-clip/scripts/video-smoke.ts\n" +
      "         [--out-dir DIR] [--env-file FILE] [--keep]\n" +
      "         [--duration 4..15|auto] [--resolution 480p|720p|1080p]\n" +
      "         [--aspect 1:1|9:16|16:9]",
  );
  process.exit(2);
}

function expandHome(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  return path === "~" ? home : path.replace(/^~\//, `${home}/`);
}

function parseEnvFile(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8");
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
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

function loadFalKey(envFile?: string): void {
  const candidates = [
    envFile,
    process.env.DEV_DISTILLERY_ENV,
    "~/development.nosync/distillery/.env",
  ].filter((path): path is string => Boolean(path?.trim()));
  for (const candidate of candidates) {
    const path = expandHome(candidate);
    if (!existsSync(path)) continue;
    const env = parseEnvFile(path);
    if (!process.env.FAL_KEY && env.FAL_KEY) process.env.FAL_KEY = env.FAL_KEY;
    return;
  }
}

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (proc.status !== 0) {
    throw new Error(`ffmpeg failed: ${proc.stderr.toString().slice(-800)}`);
  }
}

async function makeReferencePngs(dir: string): Promise<{ identity: string; storyboard: string }> {
  const identity = join(dir, "identity.png");
  const storyboard = join(dir, "storyboard.png");
  runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x172033:s=512x512:d=1",
    "-frames:v",
    "1",
    identity,
  ]);
  runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=512x512:d=1",
    "-frames:v",
    "1",
    storyboard,
  ]);
  return { identity, storyboard };
}

function looksLikeMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const marker = String.fromCharCode(...bytes.slice(4, 8));
  return marker === "ftyp";
}

let outDir = "";
let envFile: string | undefined;
let keep = false;
let duration: VideoDuration = "4";
let resolution: VideoResolution = "480p";
let aspect: AspectRatio = "1:1";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--out-dir") {
    outDir = args[++i] ?? usage();
  } else if (arg === "--env-file") {
    envFile = args[++i] ?? usage();
  } else if (arg === "--keep") {
    keep = true;
  } else if (arg === "--duration") {
    const value = args[++i];
    if (!isValidDuration(value)) usage();
    duration = value;
  } else if (arg === "--resolution") {
    const value = args[++i];
    if (value !== "480p" && value !== "720p" && value !== "1080p") usage();
    resolution = value;
  } else if (arg === "--aspect") {
    const value = args[++i];
    if (value !== "1:1" && value !== "9:16" && value !== "16:9") usage();
    aspect = value;
  } else {
    usage();
  }
}

loadFalKey(envFile);

const workDir = outDir
  ? resolve(outDir)
  : join(tmpdir(), `make-clip-video-smoke-${Date.now()}`);
await mkdir(workDir, { recursive: true });

try {
  const promptPath = join(workDir, "prompt.md");
  await writeFile(
    promptPath,
    [
      "Create a short square animation from these two references.",
      "Use @Image1 for the quiet dark-blue visual identity.",
      "Use @Image2 for motion energy and color contrast.",
      "A simple bright signal travels across the frame, pauses, then locks into",
      "place. No text, no logos, no UI, no subtitles. Locked camera.",
    ].join("\n"),
  );
  const refs = await makeReferencePngs(workDir);
  console.error(`Uploading smoke references from ${workDir}...`);
  const identityUrl = await uploadToFalStorage(
    new Uint8Array(await readFile(refs.identity)),
    basename(refs.identity),
  );
  const storyboardUrl = await uploadToFalStorage(
    new Uint8Array(await readFile(refs.storyboard)),
    basename(refs.storyboard),
  );

  console.error(`Generating smoke video (${duration}s, ${resolution}, ${aspect}, audio=false)...`);
  const result = await generateVideo(
    {
      prompt: await Bun.file(promptPath).text(),
      imageUrls: [identityUrl, storyboardUrl],
      duration,
      resolution,
      aspectRatio: aspect,
      generateAudio: false,
    },
    { onStatus: (status) => process.stderr.write(`\r  fal status: ${status}   `) },
  );
  process.stderr.write("\n");
  if (!looksLikeMp4(result.bytes)) {
    throw new Error(`generated bytes do not look like an MP4 (${result.bytes.length} bytes)`);
  }
  const out = join(workDir, "video-smoke.mp4");
  await writeFile(out, result.bytes);
  const report = {
    ok: true,
    out,
    bytes: result.bytes.length,
    contentType: result.contentType,
    requestId: result.request_id,
    sourceUrl: result.url,
    duration,
    resolution,
    aspect,
    kept: keep || Boolean(outDir),
  };
  await writeFile(join(workDir, "video-smoke-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  const message =
    e instanceof FalError && e.isAuth
      ? `FAL auth failed (${e.status}). Set FAL_KEY or pass --env-file.`
      : e instanceof Error
        ? e.message
        : String(e);
  await writeFile(
    join(workDir, "video-smoke-report.json"),
    JSON.stringify({ ok: false, error: message }, null, 2) + "\n",
  ).catch(() => {});
  console.error(`video smoke failed: ${message}`);
  process.exit(e instanceof FalError && e.isAuth ? 3 : 1);
}
