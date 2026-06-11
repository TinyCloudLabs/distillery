#!/usr/bin/env bun
// index-corpus.ts — build/refresh the incremental corpus index (CLI).
//
// Usage:
//   bun skills/index-corpus/scripts/index-corpus.ts \
//     [<dir-or-file>...] \
//     [--index-path index/corpus-index.json] \
//     [--full]    # ignore hashes, re-process everything
//     [--prune]   # drop index records whose source file no longer exists
//
// Dir resolution order (§2): positional args → else $TRANSCRIPT_DIRS
// (comma-separated absolute dirs) → else error listing every source checked.
// NOTHING is hardcoded.
//
// Deterministic plumbing only — no model calls. Walks the dirs, content-hashes
// each .md/.txt file, and re-parses ONLY new or changed files (unchanged ones
// load from the existing index). Skipped-empty Soundcore files are recorded
// `empty: true` and counted, never re-parsed into junk turns. Prints counts +
// keys to stderr; NEVER prints transcript content.

import {
  buildIndex,
  readIndex,
  resolveInputs,
  writeIndex,
} from "./corpus-index.ts";

function usage(): never {
  console.error(
    "usage: bun skills/index-corpus/scripts/index-corpus.ts [<dir-or-file>...] " +
      "[--index-path index/corpus-index.json] [--full] [--prune]",
  );
  process.exit(2);
}

const positional: string[] = [];
let indexPath = "index/corpus-index.json";
let full = false;
let prune = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--index-path") {
    const v = args[++i];
    if (!v) usage();
    indexPath = v;
  } else if (arg === "--full") {
    full = true;
  } else if (arg === "--prune") {
    prune = true;
  } else if (arg === "--help" || arg === "-h") {
    usage();
  } else if (arg.startsWith("--")) {
    usage();
  } else {
    positional.push(arg);
  }
}

let inputs: string[];
try {
  inputs = resolveInputs(positional);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

const previous = await readIndex(indexPath);
const { index, stats } = await buildIndex({ inputs, previous, full, prune });
await writeIndex(indexPath, index);

// Counts + keys only — never any transcript content.
console.error(
  `Indexed ${stats.total} transcript(s) → ${indexPath}\n` +
    `  reprocessed: ${stats.reprocessed} (added ${stats.added}), ` +
    `unchanged: ${stats.unchanged}, pruned: ${stats.pruned}, ` +
    `empty: ${stats.empty}, warnings: ${stats.warnings}`,
);
if (stats.warnings > 0) {
  for (const w of index.warnings) console.error(`  WARNING: ${w}`);
}
