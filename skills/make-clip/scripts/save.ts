#!/usr/bin/env bun
// save.ts — validate a clip artifact JSON against the contract and persist it
// to <out-dir>/clip/<slug>/ together with its media: the mp4 (the captioned
// cut is the default `media`; the clean cut is kept alongside), and a poster
// frame (the feed's still). The poster is sampled from the clip AFTER the
// climax resolves when not supplied (the prototype's "sample the final panel
// after the climax" lock) — default 90% through the clip.
//
// The clip artifact reuses the distillery artifact contract: type "clip",
// hero_image = the poster frame, audio = unused (video carries its own), and
// the mp4 itself lives in the folder referenced by a media file name. The
// feed already serves /media/<...> for any file in the artifact dir.
//
// Usage:
//   bun skills/make-clip/scripts/save.ts <artifact.json> \
//     --video clip-captioned.mp4 [--clean clip.mp4] [--poster poster.png] \
//     [--narrative narrative.md] [--out-dir artifacts]

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  newArtifactId,
  validateArtifact,
  writeArtifact,
} from "../../_shared/lib/artifact.ts";

function usage(): never {
  console.error(
    "usage: bun skills/make-clip/scripts/save.ts <artifact.json> --video FILE\n" +
      "         [--clean FILE] [--poster FILE] [--narrative FILE] [--out-dir DIR]",
  );
  process.exit(2);
}

let file: string | undefined;
let videoFile: string | undefined;
let cleanFile: string | undefined;
let posterFile: string | undefined;
let narrativeFile: string | undefined;
let outDir: string | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--video") { videoFile = args[++i]; if (!videoFile) usage(); }
  else if (arg === "--clean") { cleanFile = args[++i]; if (!cleanFile) usage(); }
  else if (arg === "--poster") { posterFile = args[++i]; if (!posterFile) usage(); }
  else if (arg === "--narrative") { narrativeFile = args[++i]; if (!narrativeFile) usage(); }
  else if (arg === "--out-dir") { outDir = args[++i]; if (!outDir) usage(); }
  else if (arg.startsWith("--")) usage();
  else if (!file) file = arg;
  else usage();
}
if (!file || !videoFile) usage();

const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
raw.id ??= newArtifactId();
raw.type ??= "clip";
raw.generated_at ??= new Date().toISOString();
raw.generation_model ??= "seedance-2.0";

if (raw.type !== "clip") {
  console.error(`make-clip saves type "clip" artifacts, got "${String(raw.type)}".`);
  process.exit(1);
}

const videoBytes = await readFile(videoFile);
if (videoBytes.length === 0) {
  console.error(`Video file ${videoFile} is empty — refusing to save an empty clip.`);
  process.exit(1);
}

const videoName = basename(videoFile);
const media: Record<string, Uint8Array> = {
  [videoName]: new Uint8Array(videoBytes),
};
// The contract has no typed `video` field yet. The mp4 lives in the artifact
// folder alongside the json, and its file name is recorded as a `video:<file>`
// tag (the feed serves /media/<...> for any file in the artifact dir). The
// feed-wiring follow-up (see SKILL.md) adds a typed video field; until then the
// tag is the contract-clean way to point at the clip.
raw.tags = Array.isArray(raw.tags) ? raw.tags : [];
const tags = raw.tags as string[];
if (!tags.includes(`video:${videoName}`)) tags.push(`video:${videoName}`);

if (cleanFile) {
  const cleanName = basename(cleanFile);
  if (cleanName !== videoName) {
    media[cleanName] = new Uint8Array(await readFile(cleanFile));
    if (!tags.includes(`video-clean:${cleanName}`)) tags.push(`video-clean:${cleanName}`);
  }
}

// Poster frame: supplied, or sampled from the clip after the climax (90%).
let posterName: string | undefined;
if (posterFile) {
  posterName = basename(posterFile);
  media[posterName] = new Uint8Array(await readFile(posterFile));
} else if (Bun.which("ffmpeg")) {
  const tmpPoster = join(tmpdir(), `make-clip-poster-${crypto.randomUUID()}.png`);
  // Sample at 90% of duration — after the climax resolves (the held button).
  let seek = "13.5"; // default for a 15s clip
  if (Bun.which("ffprobe")) {
    const p = Bun.spawnSync([
      "ffprobe", "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", videoFile,
    ]);
    const dur = Number(p.stdout.toString().trim());
    if (Number.isFinite(dur) && dur > 0) seek = (dur * 0.9).toFixed(2);
  }
  const proc = Bun.spawnSync(
    ["ffmpeg", "-y", "-ss", seek, "-i", videoFile, "-frames:v", "1", tmpPoster],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (proc.exitCode === 0) {
    posterName = "poster.png";
    media[posterName] = new Uint8Array(await readFile(tmpPoster));
  } else {
    console.error("WARNING: could not sample a poster frame (ffmpeg failed); saving without hero_image.");
  }
} else {
  console.error("WARNING: ffmpeg not found — no poster frame sampled; saving without hero_image. Pass --poster to supply one.");
}
if (posterName) raw.hero_image = posterName;

if (narrativeFile) {
  media["narrative.md"] = new Uint8Array(await readFile(narrativeFile));
}

const result = validateArtifact(raw);
if (!result.ok) {
  console.error("Artifact failed contract validation:");
  for (const err of result.errors) console.error(`  - ${err}`);
  process.exit(1);
}

const written = await writeArtifact(result.artifact, { outDir, media });
console.log(`Saved: ${written.jsonPath}`);
console.log(
  `Media: ${videoName} (${videoBytes.length} bytes)` +
    `${posterName ? `, ${posterName} (poster)` : ""}` +
    `${narrativeFile ? ", narrative.md" : ""}`,
);
console.log(
  "NOTE: the contract has no typed video field yet — the mp4 is recorded as a " +
    "`video:<file>` tag and lives in the artifact folder. Feed-wiring follow-up " +
    "adds a typed video field + per-media aspect override (see SKILL.md).",
);
