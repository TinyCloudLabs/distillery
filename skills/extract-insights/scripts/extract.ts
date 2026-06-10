#!/usr/bin/env bun
// extract.ts — parse + chunk transcripts into agent-ready JSON.
//
// Usage:
//   bun skills/extract-insights/scripts/extract.ts <path>... [--max-chunk 8000] [--out chunks.json]
//
// Paths may be .md/.txt files or directories (recursed). Deterministic
// plumbing only: no model calls, no selection. The agent reading SKILL.md
// does the judgment on the emitted chunks.

import { writeFile } from "node:fs/promises";
import {
  chunkTranscript,
  loadTranscripts,
  type TranscriptChunk,
} from "../../_shared/lib/transcript.ts";

interface ExtractOutput {
  transcripts: {
    path: string;
    title?: string;
    date?: string;
    participants?: string[];
    summary?: string;
  }[];
  chunks: TranscriptChunk[];
}

function usage(): never {
  console.error(
    "usage: bun skills/extract-insights/scripts/extract.ts <transcript-path>... [--max-chunk N] [--out file.json]",
  );
  process.exit(2);
}

const paths: string[] = [];
let maxChunk = 8000;
let outFile: string | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--max-chunk") {
    const v = Number(args[++i]);
    if (!Number.isFinite(v) || v <= 0) usage();
    maxChunk = v;
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

const output: ExtractOutput = {
  transcripts: transcripts.map((t) => ({
    path: t.path,
    title: t.title,
    date: t.date,
    participants: t.participants,
    summary: t.summary,
  })),
  chunks: transcripts.flatMap((t) => chunkTranscript(t, maxChunk)),
};

const json = JSON.stringify(output, null, 2);
if (outFile) {
  await writeFile(outFile, json + "\n");
  console.error(
    `Wrote ${output.chunks.length} chunks from ${transcripts.length} transcript(s) to ${outFile}`,
  );
} else {
  console.log(json);
}
