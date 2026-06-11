#!/usr/bin/env bun
// query-corpus.ts — retrieve from the corpus index (CLI, spec §3).
//
// Usage:
//   bun skills/query-corpus/scripts/query-corpus.ts \
//     [--index-path index/corpus-index.json] \
//     [--since 2026-06-04] [--until 2026-06-11]   # inclusive date window \
//     [--speaker "Sam"] [--entity "OpenKey"] [--term permissioning] \
//     [--source soundcore] \
//     [--artifacts-dir artifacts]      # prior-artifact surfaced baseline \
//     [--ledger index/surfaced.json]   # persisted surfaced-topics ledger \
//     [--unsurfaced-only]              # drop already-surfaced matches \
//     [--include-empty]                # include flagged-empty records \
//     [--limit N] [--format json|md]
//
// Filters AND together; with no filters it returns the whole index (capped by
// --limit). All filtering is over the index — query-corpus NEVER re-reads
// transcript files. The "already surfaced" mark unions the prior-artifact
// baseline (artifacts/) with the persisted ledger (index/surfaced.json).
//
// Deterministic plumbing only — no model calls. Prints the result (json or md)
// to STDOUT so it can be piped; counts go to stderr.

import { readIndex, type IndexRecord } from "../../index-corpus/scripts/corpus-index.ts";
import { readLedger } from "./surfaced-ledger.ts";
import {
  queryCorpusWithArtifacts,
  renderQueryMarkdown,
  type QueryOptions,
} from "./corpus-query.ts";

function usage(): never {
  console.error(
    "usage: bun skills/query-corpus/scripts/query-corpus.ts " +
      "[--index-path index/corpus-index.json] [--since YYYY-MM-DD] [--until YYYY-MM-DD] " +
      "[--speaker NAME] [--entity NAME] [--term WORD] [--source fireflies|gemini|soundcore|unknown] " +
      "[--artifacts-dir artifacts] [--ledger index/surfaced.json] " +
      "[--unsurfaced-only] [--include-empty] [--limit N] [--format json|md]",
  );
  process.exit(2);
}

const VALID_SOURCES = new Set(["fireflies", "gemini", "soundcore", "unknown"]);

let indexPath = "index/corpus-index.json";
let artifactsDir = "artifacts";
let ledgerPath = "index/surfaced.json";
let format: "json" | "md" = "json";
const opts: QueryOptions = {};

const args = process.argv.slice(2);
function takeValue(i: number): string {
  const v = args[i];
  if (v === undefined) usage();
  return v;
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  switch (arg) {
    case "--index-path":
      indexPath = takeValue(++i);
      break;
    case "--since":
      opts.since = takeValue(++i);
      break;
    case "--until":
      opts.until = takeValue(++i);
      break;
    case "--speaker":
      opts.speaker = takeValue(++i);
      break;
    case "--entity":
      opts.entity = takeValue(++i);
      break;
    case "--term":
      opts.term = takeValue(++i);
      break;
    case "--source": {
      const v = takeValue(++i);
      if (!VALID_SOURCES.has(v)) {
        console.error(`--source must be one of: ${[...VALID_SOURCES].join(", ")}`);
        process.exit(2);
      }
      opts.source = v as IndexRecord["source"];
      break;
    }
    case "--artifacts-dir":
      artifactsDir = takeValue(++i);
      break;
    case "--ledger":
      ledgerPath = takeValue(++i);
      break;
    case "--unsurfaced-only":
      opts.unsurfacedOnly = true;
      break;
    case "--include-empty":
      opts.includeEmpty = true;
      break;
    case "--limit": {
      const n = Number(takeValue(++i));
      if (!Number.isInteger(n) || n < 0) {
        console.error("--limit must be a non-negative integer");
        process.exit(2);
      }
      opts.limit = n;
      break;
    }
    case "--format": {
      const v = takeValue(++i);
      if (v !== "json" && v !== "md") usage();
      format = v;
      break;
    }
    case "--help":
    case "-h":
      usage();
    default:
      usage();
  }
}

// Empty-index grace: a missing/corrupt index yields zero matches, not a throw.
const index = (await readIndex(indexPath)) ?? {
  version: 1,
  generated_at: new Date().toISOString(),
  transcript_dirs: [],
  transcripts: [],
  warnings: [],
};
const ledger = await readLedger(ledgerPath);
const result = await queryCorpusWithArtifacts(index, artifactsDir, ledger, opts);

if (format === "md") {
  console.log(renderQueryMarkdown(result));
} else {
  console.log(JSON.stringify(result, null, 2));
}

// Counts to stderr (json/md body is on stdout for piping).
console.error(
  `Matched ${result.counts.total} transcript(s) ` +
    `(surfaced ${result.counts.surfaced}, unsurfaced ${result.counts.unsurfaced})` +
    (index.transcripts.length === 0 ? " — index is empty" : ""),
);
