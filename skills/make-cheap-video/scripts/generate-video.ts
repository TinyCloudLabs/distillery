#!/usr/bin/env bun
// generate-video.ts — generate one cheap Veo segment from a prompt file.
//
// Usage:
//   bun skills/make-cheap-video/scripts/generate-video.ts segment.prompt.md \
//     --out segment-01.mp4 [--duration 8] [--resolution 720p|1080p] \
//     [--aspect 16:9|9:16] [--model veo-3.1-lite-generate-preview] [--seed N]
//
// Defaults: Veo 3.1 Lite, 8s, 720p, 16:9. To make a 15s artifact, generate
// two 8s segments and stitch/trim them with scripts/stitch.ts.

import { writeFile } from "node:fs/promises";
import {
  generateVeoVideo,
  isValidVeoDuration,
  VEO_3_1_LITE,
  VeoError,
  type VeoAspectRatio,
  type VeoDuration,
  type VeoResolution,
} from "../../_shared/lib/veo.ts";

function usage(): never {
  console.error(
    "usage: bun skills/make-cheap-video/scripts/generate-video.ts <prompt.md> --out FILE\n" +
      "         [--duration 4|6|8] [--resolution 720p|1080p]\n" +
      "         [--aspect 16:9|9:16] [--model MODEL] [--seed N]",
  );
  process.exit(2);
}

let promptFile: string | undefined;
let outFile: string | undefined;
let duration: VeoDuration = 8;
let resolution: VeoResolution = "720p";
let aspect: VeoAspectRatio = "16:9";
let model = VEO_3_1_LITE;
let seed: number | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--out") {
    outFile = args[++i];
    if (!outFile) usage();
  } else if (arg === "--duration") {
    const raw = Number(args[++i]);
    if (!isValidVeoDuration(raw)) usage();
    duration = raw;
  } else if (arg === "--resolution") {
    const raw = args[++i];
    if (raw !== "720p" && raw !== "1080p") usage();
    resolution = raw;
  } else if (arg === "--aspect") {
    const raw = args[++i];
    if (raw !== "16:9" && raw !== "9:16") usage();
    aspect = raw;
  } else if (arg === "--model") {
    model = args[++i] ?? "";
    if (!model.trim()) usage();
  } else if (arg === "--seed") {
    const raw = args[++i];
    if (!raw || Number.isNaN(Number(raw))) usage();
    seed = Number(raw);
  } else if (arg.startsWith("--")) {
    usage();
  } else if (!promptFile) {
    promptFile = arg;
  } else {
    usage();
  }
}

if (!promptFile || !outFile) usage();

const prompt = await Bun.file(promptFile).text();
if (!prompt.trim()) {
  console.error(`Prompt file ${promptFile} is empty.`);
  process.exit(1);
}

try {
  console.error(`Generating Veo segment (${model}, ${duration}s, ${resolution}, ${aspect})...`);
  const result = await generateVeoVideo(
    {
      prompt,
      model,
      durationSeconds: duration,
      resolution,
      aspectRatio: aspect,
      seed,
    },
    {
      onStatus: (body) => {
        const done = body.done === true ? "done" : "running";
        process.stderr.write(`\r  veo status: ${done}   `);
      },
    },
  );
  process.stderr.write("\n");
  await writeFile(outFile, result.bytes);
  console.log(`Wrote ${outFile}: ${result.bytes.length} bytes (${result.contentType})`);
  console.log(`operation: ${result.operationName}`);
} catch (e) {
  if (e instanceof VeoError && e.isAuth) {
    console.error(`Gemini/Veo auth failed (${e.status}). Set GEMINI_API_KEY.`);
    process.exit(3);
  }
  console.error(`Veo generation failed: ${(e as Error).message}`);
  process.exit(1);
}
