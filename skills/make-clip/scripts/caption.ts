#!/usr/bin/env bun
// caption.ts — burn an END CAPTION onto the final seconds of a clip via
// ffmpeg drawtext. Caption is a PURE POST-PROCESS: the video model never
// renders text (it won't, reliably). The caption is an optional "language
// channel" the user opts into — when no --text is given, this just copies
// the clean clip through so callers always get a uniform pair of outputs.
//
// Audio is stream-copied (untouched); only the video is re-encoded to bake
// in the caption. Text is passed via an ffmpeg textfile (drawtext
// `textfile=`) so punctuation/quotes/commas never need shell-escaping —
// the prototype hit comma-escaping pain inlining text.
//
// Usage:
//   bun skills/make-clip/scripts/caption.ts clip.mp4 \
//     --out-captioned clip-captioned.mp4 [--out-clean clip.mp4] \
//     [--text "your data, where they can't blink it away."] \
//     [--duration 15] [--hold 2.5] [--fade 1.0] \
//     [--font /System/Library/Fonts/HelveticaNeue.ttc] [--fontsize 30]
//
// Emits BOTH a captioned and a clean output (clean = copy of the input) so
// save.ts can persist the pair. Caption fades in over the final --hold
// seconds (default 2.5s before the end), holding to the end.

import { copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CaptionStyle {
  /** Caption text (already the exact words to show). */
  text: string;
  /** Clip duration in seconds — used to place the fade-in window. */
  durationSeconds: number;
  /** Seconds before the end where the caption begins to fade in (default 2.5). */
  hold?: number;
  /** Fade-in length in seconds (default 1.0). */
  fade?: number;
  /** Absolute font file path. Default macOS Helvetica Neue. */
  fontFile?: string;
  /** Font size in px (default 30). */
  fontSize?: number;
  /** Font color (default white). */
  fontColor?: string;
}

export const DEFAULT_FONT = "/System/Library/Fonts/HelveticaNeue.ttc";

// ffmpeg parses the filtergraph argument itself: inside it, the characters
// : \ ' [ ] , are special (option/filter separators and escapes). The caption
// TEXT is safely externalized via `textfile=` so it never enters the graph,
// but `fontfile`, `fontcolor`, and the textfile PATH are concatenated raw into
// the single -vf argument. We control the textfile path (a tmpdir UUID, see
// below), so the residual untrusted-ish inputs are --font and --color: gate
// both to a charset that cannot contain any filtergraph metacharacter.
//   - fontcolor: ffmpeg color names ([a-zA-Z]) or #RRGGBB[AA] hex, optionally
//     with an @alpha suffix (e.g. "white@0.8"). Allow [A-Za-z0-9#@.].
//   - fontfile: an absolute/relative filesystem path with no graph specials.
//     Allow path-safe chars: letters, digits, / . _ - and space.
const SAFE_COLOR = /^[A-Za-z0-9#@.]+$/;
const SAFE_FONT_PATH = /^[A-Za-z0-9/._ -]+$/;

/** True when `color` is a filtergraph-safe ffmpeg color token. */
export function isSafeFontColor(color: string): boolean {
  return SAFE_COLOR.test(color);
}

/** True when `path` is a filtergraph-safe font-file path (no graph specials). */
export function isSafeFontPath(path: string): boolean {
  return SAFE_FONT_PATH.test(path);
}

/**
 * Build the drawtext filtergraph string. Pure so tests pin it exactly. The
 * alpha ramps 0→0.9 over [start, start+fade] and holds, matching the
 * prototype's `0.9*clip((t-12.5)/1.0,0,1)` at duration 15 / hold 2.5 / fade 1.
 */
export function buildDrawtextFilter(style: CaptionStyle, textFilePath: string): string {
  const hold = style.hold ?? 2.5;
  const fade = style.fade ?? 1.0;
  const fontSize = style.fontSize ?? 30;
  const fontColor = style.fontColor ?? "white";
  const fontFile = style.fontFile ?? DEFAULT_FONT;
  if (style.durationSeconds <= 0) throw new Error("caption: durationSeconds must be > 0");
  if (fade <= 0) throw new Error("caption: fade must be > 0");
  // ASSUMPTION: textFilePath is a tmpdir UUID path we generate ourselves
  // (join(tmpdir(), `make-clip-caption-${crypto.randomUUID()}.txt`)), so it is
  // free of filtergraph metacharacters by construction and safe to concatenate
  // raw. fontFile/fontColor are CLI-supplied and are charset-gated at the call
  // site (isSafeFontPath / isSafeFontColor) before reaching this builder.
  const start = Math.max(0, style.durationSeconds - hold);
  // Bottom third, centered. alpha clips into [0, 0.9] across the fade window.
  const alpha = `0.9*clip((t-${start.toFixed(3)})/${fade.toFixed(3)}\\,0\\,1)`;
  return (
    `drawtext=fontfile=${fontFile}:textfile=${textFilePath}:` +
    `fontsize=${fontSize}:fontcolor=${fontColor}:` +
    `x=(w-text_w)/2:y=0.82*h:` +
    `alpha='${alpha}'`
  );
}

/** ffmpeg argv (no leading "ffmpeg") to burn the caption; audio copied. */
export function buildCaptionArgs(input: string, output: string, filter: string): string[] {
  // prettier-ignore
  return [
    "-y", "-i", input,
    "-vf", filter,
    "-c:v", "libx264", "-crf", "18",
    "-c:a", "copy",
    "-movflags", "+faststart",
    output,
  ];
}

function usage(): never {
  console.error(
    "usage: bun skills/make-clip/scripts/caption.ts <clip.mp4>\n" +
      "         --out-captioned FILE [--out-clean FILE] [--text TEXT]\n" +
      "         [--duration SECONDS] [--hold 2.5] [--fade 1.0]\n" +
      "         [--font PATH] [--fontsize 30] [--color white]",
  );
  process.exit(2);
}

if (import.meta.main) {
  let input: string | undefined;
  let outCaptioned: string | undefined;
  let outClean: string | undefined;
  let text: string | undefined;
  let duration: number | undefined;
  let hold: number | undefined;
  let fade: number | undefined;
  let font: string | undefined;
  let fontSize: number | undefined;
  let color: string | undefined;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--out-captioned") { outCaptioned = args[++i]; if (!outCaptioned) usage(); }
    else if (arg === "--out-clean") { outClean = args[++i]; if (!outClean) usage(); }
    else if (arg === "--text") { text = args[++i]; if (text === undefined) usage(); }
    else if (arg === "--duration") { duration = Number(args[++i]); if (Number.isNaN(duration)) usage(); }
    else if (arg === "--hold") { hold = Number(args[++i]); if (Number.isNaN(hold)) usage(); }
    else if (arg === "--fade") { fade = Number(args[++i]); if (Number.isNaN(fade)) usage(); }
    else if (arg === "--font") { font = args[++i]; if (!font || !isSafeFontPath(font)) usage(); }
    else if (arg === "--fontsize") { fontSize = Number(args[++i]); if (Number.isNaN(fontSize)) usage(); }
    else if (arg === "--color") { color = args[++i]; if (!color || !isSafeFontColor(color)) usage(); }
    else if (arg.startsWith("--")) usage();
    else if (!input) input = arg;
    else usage();
  }
  if (!input || !outCaptioned) usage();

  // Always emit a clean copy too, so callers get a uniform pair.
  if (outClean) await copyFile(input, outClean);

  if (!text || !text.trim()) {
    // No caption requested — the captioned output is just the clean clip.
    await copyFile(input, outCaptioned);
    console.log(`No --text given: ${outCaptioned} is a clean copy (no caption baked in).`);
    if (outClean) console.log(`Clean copy: ${outClean}`);
    process.exit(0);
  }

  if (!Bun.which("ffmpeg")) {
    console.error("caption: ffmpeg not found on PATH — required to bake the caption.");
    process.exit(1);
  }

  // Probe duration when not passed (drawtext fade window needs it).
  let durationSeconds = duration;
  if (durationSeconds === undefined && Bun.which("ffprobe")) {
    const p = Bun.spawnSync([
      "ffprobe", "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", input,
    ]);
    const v = Number(p.stdout.toString().trim());
    if (Number.isFinite(v) && v > 0) durationSeconds = v;
  }
  if (!durationSeconds) {
    console.error("caption: could not determine duration — pass --duration SECONDS.");
    process.exit(1);
  }

  const textFile = join(tmpdir(), `make-clip-caption-${crypto.randomUUID()}.txt`);
  await writeFile(textFile, text);
  try {
    const filter = buildDrawtextFilter(
      { text, durationSeconds, hold, fade, fontFile: font, fontSize, fontColor: color },
      textFile,
    );
    const proc = Bun.spawnSync(["ffmpeg", ...buildCaptionArgs(input, outCaptioned, filter)], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      console.error(`ffmpeg caption failed:\n${proc.stderr.toString().trim().split("\n").slice(-6).join("\n")}`);
      process.exit(1);
    }
  } finally {
    await rm(textFile, { force: true });
  }

  console.log(`Captioned: ${outCaptioned}`);
  if (outClean) console.log(`Clean:     ${outClean}`);
  console.log(`Caption fades in over the final ${(hold ?? 2.5)}s; audio stream-copied untouched.`);
}
