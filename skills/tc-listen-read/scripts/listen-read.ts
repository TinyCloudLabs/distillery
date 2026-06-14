#!/usr/bin/env bun
// listen-read.ts — CLI entry for tc-listen-read. Pull recent Listen
// conversations + transcripts into a local corpus dir for the generation
// skills.
//
// Usage:
//   bun skills/tc-listen-read/scripts/listen-read.ts \
//     --out <corpus-dir> [--count 5] [--space <owner-applications-space>]
//
// --space defaults to the profile's configured default space. To read a Listen
// space owned by a DIFFERENT identity, pass the owner's space URI (and hold a
// delegation for it — see the AUTH_UNAUTHORIZED remediation below).
//
// Access remediation (§3.4): on AUTH_UNAUTHORIZED this prints the exact
// `tc auth request --cap "…"` from the error hint and the delegate handshake
// (request → owner grant → import → retry), then exits non-zero. It does NOT
// fabricate transcripts or fall back to a different space. On SPACE_NOT_HOSTED
// it prints the owner-hosting ask. The run is meant to BLOCK here until access
// lands (durable Smithers wait), then re-run.

import { TcCliError } from "../../_shared/lib/tc.ts";
import { dumpCorpus } from "./listen-read-lib.ts";

function usage(): never {
  console.error(
    "usage: bun skills/tc-listen-read/scripts/listen-read.ts --out DIR [--count N] [--space SPACE]",
  );
  process.exit(2);
}

let outDir: string | undefined;
let count = 5;
let space: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--out") {
    outDir = args[++i];
    if (!outDir || outDir.startsWith("--")) usage();
  } else if (arg === "--count") {
    const v = args[++i];
    count = Number(v);
    if (!Number.isInteger(count) || count <= 0) usage();
  } else if (arg === "--space") {
    space = args[++i];
    if (!space || space.startsWith("--")) usage();
  } else {
    usage();
  }
}
if (!outDir) usage();

function surfaceAccessRemediation(e: TcCliError): void {
  console.error(`\ntc error [${e.code}]: ${e.message}`);
  if (e.hint) console.error(`\n${e.hint}`);
  if (e.code === "AUTH_UNAUTHORIZED") {
    console.error(
      "\nDelegate handshake (if you are NOT the Listen space owner):\n" +
        "  1. agent: tc auth request --cap \"<cap from hint>\" --emit ./listen-read-request.json\n" +
        "  2. owner: tc auth grant ./listen-read-request.json --yes > ./listen-read-grant.json\n" +
        "  3. agent: tc auth import ./listen-read-grant.json\n" +
        "  4. agent: tc auth retry --last   (wait for \"covered\": true) then re-run this command.\n" +
        "If you ARE the owner, self-grant headlessly:\n" +
        "  tc auth request --cap \"<cap from hint>\" --grant --yes",
    );
  } else if (e.code === "SPACE_NOT_HOSTED") {
    console.error(
      "\nThe Listen space is not hosted. Its OWNER must host it; a delegate cannot.\n" +
        "  owner:    tc space host <name>\n" +
        "  delegate: tc space host-request <name> --emit ./host-request.json  (send to owner)",
    );
  }
}

try {
  const written = await dumpCorpus(count, outDir, { space });
  if (written.length === 0) {
    console.error(
      "No non-empty transcripts found. Nothing written. (Check the conversation count / space.)",
    );
    process.exit(1);
  }
  console.log(`Wrote ${written.length} transcript(s) to ${outDir}:`);
  for (const w of written) {
    console.log(`  - ${w.path} (${w.turnCount} turns) [${w.conversationId}]`);
  }
} catch (e) {
  if (e instanceof TcCliError) {
    surfaceAccessRemediation(e);
    process.exit(1);
  }
  console.error(`tc-listen-read: ${(e as Error).message}`);
  process.exit(1);
}
