#!/usr/bin/env bun
// generate-video.ts — the EXPENSIVE stage. Upload the two reference images
// (identity = @Image1, storyboard sheet = @Image2) to fal storage, then run
// Seedance 2.0 reference-to-video with the stage-3 prompt and write the mp4.
//
// The prompt the agent wrote uses @Image1 / @Image2 placeholders; the upload
// order here is the binding (identity FIRST so it is @Image1). No LLM here.
//
// Usage:
//   bun skills/make-clip/scripts/generate-video.ts <prompt.md> \
//     --identity identity.png --storyboard storyboard.png --out clip.mp4 \
//     [--aspect 1:1|9:16|16:9] [--duration 15] [--resolution 720p|1080p] \
//     [--no-audio] [--seed N]
//
// Defaults: aspect 1:1 (feed-native square), duration "15", resolution 720p,
// audio on. Use --resolution 1080p as the quality lever once refs are clean.

import { writeFile } from "node:fs/promises";
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
    "usage: bun skills/make-clip/scripts/generate-video.ts <prompt.md>\n" +
      "         --identity FILE --storyboard FILE --out clip.mp4\n" +
      "         [--aspect 1:1|9:16|16:9] [--duration 4..15|auto]\n" +
      "         [--resolution 480p|720p|1080p] [--no-audio] [--seed N]",
  );
  process.exit(2);
}

let promptFile: string | undefined;
let identityFile: string | undefined;
let storyboardFile: string | undefined;
let outFile: string | undefined;
let aspect: AspectRatio = "1:1";
let duration: VideoDuration = "15";
let resolution: VideoResolution = "720p";
let generateAudio = true;
let seed: number | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--identity") { identityFile = args[++i]; if (!identityFile) usage(); }
  else if (arg === "--storyboard") { storyboardFile = args[++i]; if (!storyboardFile) usage(); }
  else if (arg === "--out") { outFile = args[++i]; if (!outFile) usage(); }
  else if (arg === "--aspect") {
    const a = args[++i];
    if (a !== "1:1" && a !== "9:16" && a !== "16:9") usage();
    aspect = a;
  } else if (arg === "--duration") {
    const d = args[++i];
    if (!isValidDuration(d)) usage();
    duration = d;
  } else if (arg === "--resolution") {
    const r = args[++i];
    if (r !== "480p" && r !== "720p" && r !== "1080p") usage();
    resolution = r;
  } else if (arg === "--no-audio") {
    generateAudio = false;
  } else if (arg === "--seed") {
    const s = args[++i];
    if (!s || Number.isNaN(Number(s))) usage();
    seed = Number(s);
  } else if (arg.startsWith("--")) {
    usage();
  } else if (!promptFile) {
    promptFile = arg;
  } else {
    usage();
  }
}
if (!promptFile || !identityFile || !storyboardFile || !outFile) usage();

const prompt = await Bun.file(promptFile).text();
if (!prompt.trim()) {
  console.error(`Prompt file ${promptFile} is empty.`);
  process.exit(1);
}

try {
  // Upload identity FIRST so it is @Image1; storyboard SECOND so it is @Image2.
  console.error("Uploading identity reference (@Image1)...");
  const identityBytes = new Uint8Array(await Bun.file(identityFile).arrayBuffer());
  const identityUrl = await uploadToFalStorage(identityBytes, "identity.png");
  console.error("Uploading storyboard reference (@Image2)...");
  const storyboardBytes = new Uint8Array(await Bun.file(storyboardFile).arrayBuffer());
  const storyboardUrl = await uploadToFalStorage(storyboardBytes, "storyboard.png");

  console.error(
    `Generating video (${duration}s, ${resolution}, ${aspect}, audio=${generateAudio})...`,
  );
  const result = await generateVideo(
    {
      prompt,
      imageUrls: [identityUrl, storyboardUrl],
      duration,
      resolution,
      aspectRatio: aspect,
      generateAudio,
      seed,
    },
    { onStatus: (s) => process.stderr.write(`\r  fal status: ${s}   `) },
  );
  process.stderr.write("\n");
  await writeFile(outFile, result.bytes);
  console.log(`Wrote ${outFile}: ${result.bytes.length} bytes (${result.contentType})`);
  console.log(`request_id: ${result.request_id}`);
  const seedOut = result.raw.seed;
  if (seedOut !== undefined) console.log(`seed: ${JSON.stringify(seedOut)}`);
} catch (e) {
  if (e instanceof FalError && e.isAuth) {
    console.error(`FAL auth failed (${e.status}). Set FAL_KEY (TinyCloud Secret Manager).`);
    process.exit(3);
  }
  console.error(`Video generation failed: ${(e as Error).message}`);
  process.exit(1);
}
