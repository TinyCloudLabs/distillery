#!/usr/bin/env bun
// salient-people.ts — CLI for the SALIENT-PEOPLE detector (Phase 1b).
//
// DETERMINISTIC surfacing, NO model calls. Reads the corpus index + the existing
// person-brief artifacts and emits the top-N recurring speakers (>= N distinct
// transcripts) who do NOT yet have a current person-brief. The feed-run recipe
// runs this before the brief and embeds the candidates; the generation agent
// then judges which are worth a dossier (capped, internal audience → publishes).
//
// Usage:
//   bun harness/feed-run/scripts/salient-people.ts \
//     [--index-path index/corpus-index.json] [--artifacts-dir artifacts] \
//     [--min-transcripts 3] [--top 5] [--format md|json]
//
// Output: a JSON array (default) or a markdown list to stdout; a one-line summary
// to stderr. Never throws on a missing artifacts dir (nobody briefed).

import { readIndex } from "../../index-corpus/scripts/corpus-index.ts";
import {
  findSalientPeople,
  summarizeSalient,
  DEFAULT_SALIENCE_MIN_TRANSCRIPTS,
  DEFAULT_SALIENT_TOP,
  type SalientPerson,
} from "./salient-people-lib.ts";

function usage(): never {
  console.error(
    "usage: bun harness/feed-run/scripts/salient-people.ts " +
      "[--index-path PATH] [--artifacts-dir DIR] [--min-transcripts N] [--top N] [--format md|json]",
  );
  process.exit(2);
}

let indexPath = "index/corpus-index.json";
let artifactsDir = "artifacts";
let minTranscripts = DEFAULT_SALIENCE_MIN_TRANSCRIPTS;
let top = DEFAULT_SALIENT_TOP;
let format: "md" | "json" = "json";

const args = process.argv.slice(2);
function take(i: number): string {
  const v = args[i];
  if (v === undefined) usage();
  return v;
}
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  switch (a) {
    case "--index-path":
      indexPath = take(++i);
      break;
    case "--artifacts-dir":
      artifactsDir = take(++i);
      break;
    case "--min-transcripts": {
      const n = Number(take(++i));
      if (!Number.isInteger(n) || n < 1) {
        console.error("--min-transcripts must be a positive integer");
        process.exit(2);
      }
      minTranscripts = n;
      break;
    }
    case "--top": {
      const n = Number(take(++i));
      if (!Number.isInteger(n) || n < 0) {
        console.error("--top must be a non-negative integer");
        process.exit(2);
      }
      top = n;
      break;
    }
    case "--format": {
      const v = take(++i);
      if (v !== "md" && v !== "json") usage();
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

const index = await readIndex(indexPath);
if (index === undefined) {
  console.error(`[salient-people] no index at ${indexPath} — emitting empty.`);
  console.log(format === "md" ? "- (none — no index)" : "[]");
  process.exit(0);
}

const people: SalientPerson[] = await findSalientPeople(index, artifactsDir, {
  minTranscripts,
  top,
});

console.error(`[salient-people] ${summarizeSalient(people, minTranscripts)}`);

if (format === "md") {
  if (people.length === 0) {
    console.log(`- (none — no recurring un-briefed speakers >= ${minTranscripts} transcripts)`);
  } else {
    for (const p of people) {
      console.log(
        `- **${p.name}** — ${p.transcriptCount} transcripts, ${p.turnCount} turns (slug: \`${p.slug}\`)`,
      );
    }
  }
} else {
  console.log(JSON.stringify(people, null, 2));
}
