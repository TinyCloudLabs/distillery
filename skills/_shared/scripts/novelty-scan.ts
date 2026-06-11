#!/usr/bin/env bun
// novelty-scan.ts — surface novelty CANDIDATES from a transcript corpus.
//
// Usage:
//   bun skills/_shared/scripts/novelty-scan.ts <transcript-path>... [--artifacts-dir artifacts] [--format json|md] [--out file]
//
// Paths may be .md/.txt files or directories (recursed). Deterministic
// plumbing only — no model calls, no novelty verdicts. Emits three analyses
// the agent judges during the survey step of any artifact skill:
//
//   1. Quantified-claim tracking: money/percent/count/deadline mentions with
//      context + provenance, grouped across transcripts by fuzzy topic and
//      ordered chronologically — DRIFT candidates ("$100K to close" in one
//      meeting, "eventually" two weeks later).
//   2. Single-voice topics: terms only ONE speaker uses, with engagement
//      signals — asymmetric-knowledge candidates.
//   3. Prior-artifact baseline: what artifacts/ already surfaced — angles a
//      new artifact must beat to count as novel.
//
// --format md (recommended for reading) renders a markdown report; the
// default json is for programmatic use. A missing artifacts dir is not an
// error — the baseline is simply empty (fresh repo).

import { writeFile } from "node:fs/promises";
import { loadTranscripts } from "../lib/transcript.ts";
import { buildNoveltyScan, renderNoveltyMarkdown } from "../lib/novelty.ts";

function usage(): never {
  console.error(
    "usage: bun skills/_shared/scripts/novelty-scan.ts <transcript-path>... [--artifacts-dir dir] [--format json|md] [--out file]",
  );
  process.exit(2);
}

const paths: string[] = [];
let artifactsDir = "artifacts";
let format: "json" | "md" = "json";
let outFile: string | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--artifacts-dir") {
    const v = args[++i];
    if (!v) usage();
    artifactsDir = v;
  } else if (arg === "--format") {
    const v = args[++i];
    if (v !== "json" && v !== "md") usage();
    format = v;
  } else if (arg === "--out") {
    outFile = args[++i];
    if (!outFile) usage();
  } else if (arg.startsWith("--")) {
    usage();
  } else {
    paths.push(arg);
  }
}
if (paths.length === 0) usage();

const transcripts = await loadTranscripts(paths);
if (transcripts.length === 0) {
  console.error(`No .md/.txt transcripts found under: ${paths.join(", ")}`);
  process.exit(1);
}

const scan = await buildNoveltyScan(transcripts, artifactsDir);

const rendered =
  format === "md" ? renderNoveltyMarkdown(scan) : JSON.stringify(scan, null, 2) + "\n";
if (outFile) {
  await writeFile(outFile, rendered);
  console.error(
    `Wrote ${format} novelty scan (${scan.transcriptCount} transcript(s), ` +
      `${scan.quantities.groups.length} drift group(s), ${scan.singleVoice.length} single-voice topic(s), ` +
      `${scan.baseline.entries.length} prior artifact(s)) to ${outFile}`,
  );
} else {
  process.stdout.write(rendered);
}
