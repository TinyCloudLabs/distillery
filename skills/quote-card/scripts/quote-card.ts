#!/usr/bin/env bun
// quote-card.ts — render a strong line from an APPROVED artifact as a
// high-signal, minimal text-on-image quote card, and persist it as its own
// `quote-card` artifact (with provenance carried from the source).
//
// Usage (generate):
//   bun skills/quote-card/scripts/quote-card.ts \
//     --source-dir artifacts/social-post/<slug> \
//     (--prompt "..." | --prompt-file prompt.txt) \
//     [--line "the exact quote line"] \
//     [--aspect 1:1] [--text-mode model-baked|composited] \
//     [--out-dir artifacts] [--note "..."] [--skip-existing]
//
// Usage (record a quality-loop verdict without generating):
//   bun skills/quote-card/scripts/quote-card.ts \
//     --quote-dir artifacts/quote-card/<slug> --annotate "..."
//
// Deterministic plumbing only — NO model judgment in this script. The agent
// reading SKILL.md crafts the visual-concept prompt, picks the line, judges
// the rendered card (zoom-inspecting any baked text), and decides retry/accept.
// This script: (1) refuses to operate on a non-approved source, (2) calls the
// image model, (3) writes quote.<ext> + a contract-valid `quote-card`
// artifact.json carrying the source's provenance, and (4) appends quality
// notes. `--annotate` records a note on an existing quote-card without
// generating. Exits non-zero on any failure.

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import {
  validateArtifact,
  newArtifactId,
  slugify,
  type Artifact,
} from "../../_shared/lib/artifact.ts";
import {
  generateImage,
  type GenerateImageOptions,
  type GeneratedImage,
} from "../../_shared/lib/gemini.ts";

export const IMAGE_MODEL_NOTE = "gemini-2.5-flash-image";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const TEXT_MODES = ["model-baked", "composited"] as const;
export type TextMode = (typeof TEXT_MODES)[number];

export class UsageError extends Error {}

export interface QuoteCardArgs {
  /** APPROVED source artifact dir (generate mode). */
  sourceDir?: string;
  /** Existing quote-card artifact dir (annotate mode). */
  quoteDir?: string;
  prompt?: string;
  promptFile?: string;
  annotate?: string;
  /** The exact line rendered on the card; defaults to source.quote ?? headline. */
  line?: string;
  aspectRatio: string;
  textMode: TextMode;
  /** Output root for the new quote-card artifact; defaults to ./artifacts. */
  outDir?: string;
  note?: string;
  skipExisting: boolean;
}

export function parseArgs(argv: string[]): QuoteCardArgs {
  let sourceDir: string | undefined;
  let quoteDir: string | undefined;
  let prompt: string | undefined;
  let promptFile: string | undefined;
  let annotate: string | undefined;
  let line: string | undefined;
  let aspectRatio = "1:1";
  let textMode: TextMode = "composited";
  let outDir: string | undefined;
  let note: string | undefined;
  let skipExisting = false;

  const value = (flag: string, v: string | undefined): string => {
    if (v === undefined || v.startsWith("--")) {
      throw new UsageError(`${flag} requires a value`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--source-dir":
        sourceDir = value(arg, argv[++i]);
        break;
      case "--quote-dir":
        quoteDir = value(arg, argv[++i]);
        break;
      case "--prompt":
        prompt = value(arg, argv[++i]);
        break;
      case "--prompt-file":
        promptFile = value(arg, argv[++i]);
        break;
      case "--annotate":
        annotate = value(arg, argv[++i]);
        break;
      case "--line":
        line = value(arg, argv[++i]);
        break;
      case "--aspect":
        aspectRatio = value(arg, argv[++i]);
        break;
      case "--text-mode": {
        const v = value(arg, argv[++i]);
        if (!TEXT_MODES.includes(v as TextMode)) {
          throw new UsageError(
            `--text-mode must be one of ${TEXT_MODES.join(", ")}`,
          );
        }
        textMode = v as TextMode;
        break;
      }
      case "--out-dir":
        outDir = value(arg, argv[++i]);
        break;
      case "--note":
        note = value(arg, argv[++i]);
        break;
      case "--skip-existing":
        skipExisting = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  // Annotate mode (record a verdict) vs generate mode (make a card).
  if (annotate !== undefined) {
    if (!quoteDir) {
      throw new UsageError("--annotate requires --quote-dir");
    }
    if (
      sourceDir !== undefined ||
      prompt !== undefined ||
      promptFile !== undefined ||
      line !== undefined ||
      note !== undefined ||
      outDir !== undefined ||
      skipExisting
    ) {
      throw new UsageError(
        "--annotate takes only --quote-dir (no generation flags)",
      );
    }
    return {
      quoteDir,
      annotate,
      aspectRatio,
      textMode,
      skipExisting: false,
    };
  }

  if (!sourceDir) {
    throw new UsageError("--source-dir is required when generating");
  }
  if (quoteDir !== undefined) {
    throw new UsageError("--quote-dir only applies to --annotate");
  }
  const promptModes = [prompt, promptFile].filter((m) => m !== undefined);
  if (promptModes.length !== 1) {
    throw new UsageError("exactly one of --prompt or --prompt-file is required");
  }

  return {
    sourceDir,
    prompt,
    promptFile,
    line,
    aspectRatio,
    textMode,
    outDir,
    note,
    skipExisting,
  };
}

/** Injection point for tests: same shape as the shared generateImage. */
export type ImageProvider = (
  opts: GenerateImageOptions,
) => Promise<GeneratedImage>;

export interface QuoteCardResult {
  status: "generated" | "skipped" | "annotated";
  /** quote-card artifact dir. */
  quoteDir: string;
  jsonPath: string;
  /** Absolute path of the written card file (status "generated" only). */
  cardPath?: string;
  /** The line rendered on the card (status "generated" only). */
  line?: string;
}

const TAG = "[quote-card]";

function appendNote(existing: string | undefined, note: string): string {
  const tagged = `${TAG} ${note}`;
  return existing?.trim() ? `${existing.trim()} | ${tagged}` : tagged;
}

async function loadArtifact(jsonPath: string): Promise<Artifact> {
  let raw: string;
  try {
    raw = await readFile(jsonPath, "utf8");
  } catch {
    throw new Error(`no artifact.json found at ${jsonPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`artifact.json is not valid JSON: ${(e as Error).message}`);
  }
  const result = validateArtifact(parsed);
  if (!result.ok) {
    throw new Error(
      `artifact.json fails the contract:\n  - ${result.errors.join("\n  - ")}`,
    );
  }
  return result.artifact;
}

async function persistArtifact(jsonPath: string, artifact: Artifact): Promise<void> {
  const result = validateArtifact(artifact);
  if (!result.ok) {
    throw new Error(
      `refusing to write contract-invalid artifact:\n  - ${result.errors.join("\n  - ")}`,
    );
  }
  await writeFile(jsonPath, JSON.stringify(artifact, null, 2) + "\n");
}

/**
 * The line that goes on the card: explicit --line wins; else the source's
 * pull quote; else its headline. Trimmed; must be non-empty.
 */
export function resolveLine(source: Artifact, explicit?: string): string {
  const line = (explicit ?? source.quote ?? source.headline ?? "").trim();
  if (!line) {
    throw new Error(
      "no line to render: pass --line, or give the source artifact a quote/headline",
    );
  }
  return line;
}

export async function quoteCard(
  args: QuoteCardArgs,
  provider: ImageProvider = generateImage,
): Promise<QuoteCardResult> {
  // ---- Annotate mode: record a verdict on an existing quote-card. ----
  if (args.annotate !== undefined) {
    const jsonPath = join(args.quoteDir!, "artifact.json");
    const artifact = await loadArtifact(jsonPath);
    artifact.quality.notes = appendNote(artifact.quality.notes, args.annotate);
    await persistArtifact(jsonPath, artifact);
    return { status: "annotated", quoteDir: args.quoteDir!, jsonPath };
  }

  // ---- Generate mode. ----
  const sourceJson = join(args.sourceDir!, "artifact.json");
  const source = await loadArtifact(sourceJson);

  // Hard gate: quote-card operates on APPROVED content only. Outward types
  // default to "pending"; we require an explicit "approved".
  if (source.approval_status !== "approved") {
    throw new Error(
      `source artifact is not approved (approval_status=${
        source.approval_status ?? "unset"
      }); quote-card operates on APPROVED content only`,
    );
  }

  const line = resolveLine(source, args.line);

  // Resolve the destination quote-card artifact dir up front so --skip-existing
  // and the write target agree. Slug is derived from the line (the card's face).
  const outRoot = args.outDir ?? join(process.cwd(), "artifacts");
  const slug = slugify(line);
  const quoteDir = join(outRoot, "quote-card", slug);
  const jsonPath = join(quoteDir, "artifact.json");

  if (args.skipExisting && existsSync(jsonPath)) {
    const existing = await loadArtifact(jsonPath);
    if (existing.hero_image && existsSync(join(quoteDir, existing.hero_image))) {
      return { status: "skipped", quoteDir, jsonPath };
    }
  }

  let prompt = args.prompt;
  if (args.promptFile !== undefined) {
    const pf = isAbsolute(args.promptFile)
      ? args.promptFile
      : join(process.cwd(), args.promptFile);
    try {
      prompt = (await readFile(pf, "utf8")).trim();
    } catch {
      throw new Error(`could not read prompt file: ${args.promptFile}`);
    }
  }
  if (!prompt?.trim()) throw new Error("prompt is empty");
  prompt = prompt.trim();

  const image = await provider({ prompt, aspectRatio: args.aspectRatio });
  const ext = MIME_EXT[image.mimeType] ?? "png";
  const cardName = `quote.${ext}`;
  const cardPath = join(quoteDir, cardName);

  await mkdir(quoteDir, { recursive: true });
  await writeFile(cardPath, image.bytes);

  // A regeneration can change the extension; drop a stale card file.
  let existingNotes: string | undefined;
  if (existsSync(jsonPath)) {
    const prior = await loadArtifact(jsonPath).catch(() => undefined);
    existingNotes = prior?.quality.notes;
    if (prior?.hero_image && prior.hero_image !== cardName) {
      await unlink(join(quoteDir, prior.hero_image)).catch(() => {});
    }
  }

  const noteText =
    args.note ??
    `card rendered (${IMAGE_MODEL_NOTE}, text-mode=${args.textMode})` +
      (args.textMode === "model-baked"
        ? " — ZOOM-INSPECT baked text before accepting"
        : " — text overlay composited separately, not model-baked");

  // The quote-card artifact: a NEW outward artifact carrying the source's
  // provenance. It starts "pending" (the contract default for outward types):
  // the visual packaging is its own thing to approve, separate from the
  // already-approved source copy.
  const artifact: Artifact = {
    id: newArtifactId(),
    type: "quote-card",
    headline: source.headline,
    quote: line,
    attribution: source.attribution,
    tags: source.tags,
    source_transcripts: source.source_transcripts,
    source_quotes: source.source_quotes,
    hero_image: cardName,
    generated_at: new Date().toISOString(),
    generation_model: IMAGE_MODEL_NOTE,
    quality: {
      // The card inherits the source's verified provenance; the visual itself
      // still needs the agent's eyes (recorded via --annotate / the loop).
      critic_pass: false,
      quotes_verified: source.quality.quotes_verified,
      notes: appendNote(
        existingNotes,
        `derived from approved ${source.type} "${source.headline}". ${noteText}`,
      ),
    },
    audience: source.audience,
    platform: source.platform,
    // approval_status intentionally omitted → contract defaults to "pending".
  };

  await persistArtifact(jsonPath, artifact);
  return { status: "generated", quoteDir, jsonPath, cardPath, line };
}

const USAGE = `usage: bun skills/quote-card/scripts/quote-card.ts
  --source-dir <approved-artifact-dir> (--prompt "..." | --prompt-file f.txt)
  [--line "exact line"] [--aspect 1:1] [--text-mode model-baked|composited]
  [--out-dir artifacts] [--note "..."] [--skip-existing]
or, to record a quality note on an existing quote-card without generating:
  --quote-dir <quote-card-dir> --annotate "..."`;

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await quoteCard(args);
    switch (result.status) {
      case "generated":
        console.log(`Wrote ${result.cardPath}`);
        console.log(`Line: ${result.line}`);
        console.log(`Wrote ${result.jsonPath} (quote-card artifact, pending approval)`);
        break;
      case "skipped":
        console.log(
          `Skipped: quote-card already exists at ${result.jsonPath} (--skip-existing)`,
        );
        break;
      case "annotated":
        console.log(`Updated quality.notes in ${result.jsonPath}`);
        break;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(USAGE);
      console.error(`error: ${e.message}`);
      process.exit(2);
    }
    console.error(`quote-card: ${(e as Error).message}`);
    process.exit(1);
  }
}
