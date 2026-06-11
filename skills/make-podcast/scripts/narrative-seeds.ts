#!/usr/bin/env bun
// narrative-seeds.ts — surface ranked NARRATIVE SEEDS from a transcript set for
// the podcast survey. This is the material-format-matching lever: a podcast
// needs a sustained THROUGH-LINE across meetings (a real before→after), which
// is a structurally higher bar than a card's single insight. The script scores
// the candidate SET for narrative potential using index-available signals and
// surfaces the arc skeleton; the agent reading SKILL.md judges whether the arc
// is real.
//
// Usage:
//   bun skills/make-podcast/scripts/narrative-seeds.ts <transcript-path>... [--format json|md] [--min-span N] [--max-seeds N] [--out file]
//
// Paths may be .md/.txt files or directories (recursed). Deterministic
// plumbing only — NO model calls, no episode verdicts. Three seed kinds:
//
//   1. quantified-drift    — a tracked quantity whose VALUE moved across 2+
//                            meetings (a number/commitment that changed = an
//                            inherent arc).
//   2. single-voice-arc    — a single-voice topic one person carries across
//                            3+ meetings WITH an engagement shift (stance
//                            development).
//   3. cross-meeting-topic — an entity/term spanning 3+ meetings with 2+
//                            speakers WITH a shift (left/re-entered the agenda,
//                            or changed hands across voices).
//
// Development requires a real shift for EVERY kind — flat recurrence (a topic
// that merely repeats with no detected movement) is floored at 0, labeled
// "recurrence only", and sorts below every real arc, just as identical
// recurring quantities score zero. Seeds are ranked by development × reach. A
// set with a drifting quantity scores ABOVE a flat set. Zero seeds is valid —
// it means no through-line shows temporal development, so there is no episode
// lead (a flat recap of recent meetings is a card, not an episode).

import { writeFile } from "node:fs/promises";
import { loadTranscripts } from "../../_shared/lib/transcript.ts";
import {
  renderNarrativeSeedsMarkdown,
  scoreNarrativeSeeds,
} from "../../_shared/lib/novelty.ts";

function usage(): never {
  console.error(
    "usage: bun skills/make-podcast/scripts/narrative-seeds.ts <transcript-path>... " +
      "[--format json|md] [--min-span N] [--max-seeds N] [--out file]",
  );
  process.exit(2);
}

const paths: string[] = [];
let format: "json" | "md" = "json";
let minSpan: number | undefined;
let maxSeeds: number | undefined;
let outFile: string | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--format") {
    const v = args[++i];
    if (v !== "json" && v !== "md") usage();
    format = v;
  } else if (arg === "--min-span") {
    const v = Number(args[++i]);
    if (!Number.isFinite(v) || v < 2) usage();
    minSpan = v;
  } else if (arg === "--max-seeds") {
    const v = Number(args[++i]);
    if (!Number.isFinite(v) || v <= 0) usage();
    maxSeeds = v;
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

const seeds = scoreNarrativeSeeds(transcripts, { minSpanMeetings: minSpan, maxSeeds });

const rendered =
  format === "md"
    ? renderNarrativeSeedsMarkdown(seeds)
    : JSON.stringify({ transcriptCount: transcripts.length, seeds }, null, 2) + "\n";

if (outFile) {
  await writeFile(outFile, rendered);
  console.error(
    `Wrote ${format} narrative-seed scan (${transcripts.length} transcript(s), ` +
      `${seeds.length} seed(s)) to ${outFile}`,
  );
} else {
  process.stdout.write(rendered);
}
