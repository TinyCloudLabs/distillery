#!/usr/bin/env bun
// verify-quotes.ts — prove every source_quote in an artifact JSON exists
// verbatim (whitespace-insensitive) in its referenced transcript.
//
// Usage:
//   bun skills/extract-insights/scripts/verify-quotes.ts <artifact.json>
//
// Exit 0: all quotes verified. Exit 1: at least one failed (listed).
// The agent must run this before setting quality.quotes_verified.

import { readFile } from "node:fs/promises";
import { parseTranscript, verifyQuote, type Transcript } from "../../_shared/lib/transcript.ts";
import type { SourceQuote } from "../../_shared/lib/artifact.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun skills/extract-insights/scripts/verify-quotes.ts <artifact.json>");
  process.exit(2);
}

const artifact = JSON.parse(await readFile(file, "utf8")) as {
  source_quotes?: SourceQuote[];
};
const quotes = artifact.source_quotes ?? [];
if (quotes.length === 0) {
  console.log("No source_quotes present — nothing to verify.");
  console.log(
    "Note: insight artifacts SHOULD anchor claims with source_quotes; an empty list is suspicious.",
  );
  process.exit(0);
}

const cache = new Map<string, Transcript>();
async function load(path: string): Promise<Transcript> {
  const hit = cache.get(path);
  if (hit) return hit;
  const t = parseTranscript(await readFile(path, "utf8"), path);
  cache.set(path, t);
  return t;
}

let failures = 0;
for (const [i, sq] of quotes.entries()) {
  try {
    const transcript = await load(sq.transcript);
    if (verifyQuote(transcript, sq.quote)) {
      console.log(`ok   [${i}] "${sq.quote.slice(0, 60)}..."`);
    } else {
      failures++;
      console.error(`FAIL [${i}] quote not found in ${sq.transcript}:`);
      console.error(`     "${sq.quote}"`);
    }
  } catch (e) {
    failures++;
    console.error(`FAIL [${i}] could not read ${sq.transcript}: ${(e as Error).message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${quotes.length} quote(s) failed verification. Fix or drop them.`);
  process.exit(1);
}
console.log(`\nAll ${quotes.length} quote(s) verified.`);
