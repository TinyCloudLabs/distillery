#!/usr/bin/env bun
// stitch.ts — concatenate Veo Lite segments and trim to a target runtime.
//
// Usage:
//   bun skills/make-cheap-video/scripts/stitch.ts segment-01.mp4 segment-02.mp4 \
//     --out clip.mp4 [--target-duration 15]
//
// The cheap path defaults to a 15s deliverable. Veo 3.1 Lite currently only
// emits 4/6/8s generations, so the normal plan is 8s + 8s -> trim to 15s.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function planVeoLiteSegments(targetSeconds = 15): number[] {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
    throw new Error(`targetSeconds must be positive, got ${targetSeconds}`);
  }
  if (targetSeconds <= 4) return [4];
  if (targetSeconds <= 6) return [6];
  if (targetSeconds <= 8) return [8];

  const out: number[] = [];
  let total = 0;
  while (total < targetSeconds) {
    out.push(8);
    total += 8;
  }
  return out;
}

function usage(): never {
  console.error(
    "usage: bun skills/make-cheap-video/scripts/stitch.ts <segment.mp4>... --out FILE\n" +
      "         [--target-duration 15]",
  );
  process.exit(2);
}

function concatLine(path: string): string {
  return `file '${resolve(path).replaceAll("'", "'\\''")}'`;
}

let outFile: string | undefined;
let targetDuration = 15;
const segments: string[] = [];

if (import.meta.main) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--out") {
      outFile = args[++i];
      if (!outFile) usage();
    } else if (arg === "--target-duration") {
      const raw = Number(args[++i]);
      if (!Number.isFinite(raw) || raw <= 0) usage();
      targetDuration = raw;
    } else if (arg.startsWith("--")) {
      usage();
    } else {
      segments.push(arg);
    }
  }

  if (!outFile || segments.length === 0) usage();

  if (!Bun.which("ffmpeg")) {
    console.error("ffmpeg is required to stitch cheap-video segments.");
    process.exit(1);
  }

  for (const segment of segments) {
    const bytes = await readFile(segment).catch(() => undefined);
    if (!bytes || bytes.length === 0) {
      console.error(`Segment ${segment} is missing or empty.`);
      process.exit(1);
    }
  }

  await mkdir(dirname(outFile), { recursive: true }).catch(() => {});

  const workDir = join(tmpdir(), `cheap-video-stitch-${crypto.randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  const listFile = join(workDir, "segments.txt");
  await writeFile(listFile, segments.map(concatLine).join("\n") + "\n");

  const proc = Bun.spawnSync([
    "ffmpeg",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-t",
    String(targetDuration),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outFile,
  ], { stdout: "pipe", stderr: "pipe" });

  await rm(workDir, { recursive: true, force: true }).catch(() => {});

  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    process.exit(proc.exitCode || 1);
  }

  console.log(`Saved stitched clip: ${outFile}`);
  console.log(`Target duration: ${targetDuration}s; segment plan: ${planVeoLiteSegments(targetDuration).join(" + ")}s`);
}
