#!/usr/bin/env bun
// listen-read.ts — CLI entry for tc-listen-read. Pull recent Listen
// conversations + transcripts into a local corpus dir for the generation
// skills.
//
// Usage:
//   bun skills/tc-listen-read/scripts/listen-read.ts \
//     --out <corpus-dir> [--count 5] [--space <owner-applications-space>]
//
//   # emit the delegation request the OWNER grants (then re-run the read):
//   bun skills/tc-listen-read/scripts/listen-read.ts \
//     --emit-request <file> --owner-space <owner-applications-space-uri>
//
// --space defaults to the profile's configured default space. To read a Listen
// space owned by a DIFFERENT identity, pass the owner's space URI (and hold a
// delegation for it — see the AUTH_UNAUTHORIZED remediation below).
//
// Access remediation (§3.4): on AUTH_UNAUTHORIZED, if --owner-space is known
// this auto-emits the exact request artifact (both caps, one file) and prints
// the one-command owner grant + import + retry. Otherwise it prints the manual
// handshake. It does NOT fabricate transcripts or fall back to a different
// space. On SPACE_NOT_HOSTED it prints the owner-hosting ask. The run BLOCKS
// here until access lands (durable Smithers wait), then re-runs.

import { TcCliError } from "../../_shared/lib/tc.ts";
import {
  dumpCorpus,
  emitListenReadRequest,
  listenReadCaps,
} from "./listen-read-lib.ts";

const DEFAULT_REQUEST_FILE = "./listen-read-request.json";

function usage(): never {
  console.error(
    "usage:\n" +
      "  read:  bun .../listen-read.ts --out DIR [--count N] [--space SPACE] [--profile NAME] [--owner-space URI]\n" +
      "  emit:  bun .../listen-read.ts --emit-request [FILE] --owner-space URI",
  );
  process.exit(2);
}

let outDir: string | undefined;
let count = 5;
let space: string | undefined;
let ownerSpace: string | undefined;
let profile: string | undefined;
let emitRequest = false;
let requestFile = DEFAULT_REQUEST_FILE;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--out") {
    outDir = args[++i];
    if (!outDir || outDir.startsWith("--")) usage();
  } else if (arg === "--count") {
    count = Number(args[++i]);
    if (!Number.isInteger(count) || count <= 0) usage();
  } else if (arg === "--space") {
    space = args[++i];
    if (!space || space.startsWith("--")) usage();
  } else if (arg === "--profile") {
    // Read Listen under a specific profile (e.g. `default`, which OWNS the
    // canonical Listen data) without switching the active profile. Publishing
    // still runs as the active profile (cli-test owns the artifacts space).
    profile = args[++i];
    if (!profile || profile.startsWith("--")) usage();
  } else if (arg === "--owner-space") {
    ownerSpace = args[++i];
    if (!ownerSpace || ownerSpace.startsWith("--")) usage();
  } else if (arg === "--emit-request") {
    emitRequest = true;
    // optional positional FILE (only if the next token isn't another flag)
    const next = args[i + 1];
    if (next && !next.startsWith("--")) requestFile = args[++i]!;
  } else {
    usage();
  }
}

/** Print the owner-grant + import + retry commands for an emitted request. */
function printHandshake(file: string, caps: string[]): void {
  console.error(`\nEmitted Listen-read request → ${file}`);
  console.error("Requested caps:");
  for (const cap of caps) console.error(`  - ${cap}`);
  console.error(
    "\nHand-off (the Listen owner runs ONE grant in their session):\n" +
      `  owner: tc auth grant ${file} --yes > ./listen-read-grant.json\n` +
      "         (OpenKey owners do this in a browser; local-key owners headless)\n" +
      "Then the agent ingests immediately:\n" +
      "  agent: tc auth import ./listen-read-grant.json\n" +
      "  agent: tc auth retry --last        # wait for \"covered\": true\n" +
      "  agent: re-run this command WITHOUT --emit-request to read Listen.",
  );
}

// Mode 1: just emit the request (no read attempt). Useful to hand the owner the
// grant up front, before access is even attempted.
if (emitRequest) {
  if (!ownerSpace) {
    console.error("--emit-request requires --owner-space <owner-space-uri>");
    process.exit(2);
  }
  try {
    const emitted = await emitListenReadRequest(ownerSpace, requestFile);
    printHandshake(emitted.file, emitted.caps);
    process.exit(0);
  } catch (e) {
    if (e instanceof TcCliError) {
      console.error(`\ntc error [${e.code}]: ${e.message}`);
      if (e.hint) console.error(`hint: ${e.hint}`);
      process.exit(1);
    }
    console.error(`tc-listen-read: ${(e as Error).message}`);
    process.exit(1);
  }
}

// Mode 2: read Listen into the corpus.
if (!outDir) usage();

async function surfaceAccessRemediation(e: TcCliError): Promise<void> {
  console.error(`\ntc error [${e.code}]: ${e.message}`);
  if (e.hint) console.error(`\n${e.hint}`);

  if (e.code === "AUTH_UNAUTHORIZED") {
    if (ownerSpace) {
      // We know the owner's space → emit the exact request artifact so the
      // owner's grant is one command. This is the path that makes ingesting
      // real Listen data immediate once the user runs the browser grant.
      try {
        const emitted = await emitListenReadRequest(ownerSpace, requestFile);
        printHandshake(emitted.file, emitted.caps);
      } catch (emitErr) {
        console.error(
          `\n(could not auto-emit the request: ${(emitErr as Error).message})`,
        );
      }
    } else {
      const caps = ownerSpace ? listenReadCaps(ownerSpace) : [];
      console.error(
        "\nPass --owner-space <owner-space-uri> to auto-emit the exact request\n" +
          "artifact, or run the handshake manually:\n" +
          "  1. agent: tc auth request --cap \"<cap from hint>\" --emit ./listen-read-request.json\n" +
          "  2. owner: tc auth grant ./listen-read-request.json --yes > ./listen-read-grant.json\n" +
          "  3. agent: tc auth import ./listen-read-grant.json\n" +
          "  4. agent: tc auth retry --last  (wait \"covered\": true) then re-run.\n" +
          (caps.length ? `Caps needed:\n${caps.map((c) => `  - ${c}`).join("\n")}\n` : "") +
          "If you ARE the owner (local-key), self-grant headlessly:\n" +
          "  tc auth request --cap \"<cap from hint>\" --grant --yes",
      );
    }
  } else if (e.code === "SPACE_NOT_HOSTED") {
    console.error(
      "\nThe Listen space is not hosted. Its OWNER must host it; a delegate cannot.\n" +
        "  owner:    tc space host <name>\n" +
        "  delegate: tc space host-request <name> --emit ./host-request.json  (send to owner)",
    );
  }
}

try {
  const written = await dumpCorpus(count, outDir, { space }, { profile });
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
    await surfaceAccessRemediation(e);
    process.exit(1);
  }
  console.error(`tc-listen-read: ${(e as Error).message}`);
  process.exit(1);
}
