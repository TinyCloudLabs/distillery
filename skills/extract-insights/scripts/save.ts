#!/usr/bin/env bun
// save.ts — validate an artifact JSON against the contract and persist it
// to <out-dir>/<type>/<slug>/artifact.json.
//
// Usage:
//   bun skills/extract-insights/scripts/save.ts <artifact.json> [--out-dir artifacts]

import { readFile } from "node:fs/promises";
import {
  newArtifactId,
  validateArtifact,
  writeArtifact,
} from "../../_shared/lib/artifact.ts";

function usage(): never {
  console.error(
    "usage: bun skills/extract-insights/scripts/save.ts <artifact.json> [--out-dir DIR]",
  );
  process.exit(2);
}

let file: string | undefined;
let outDir: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--out-dir") {
    outDir = args[++i];
    if (!outDir) usage();
  } else if (arg.startsWith("--")) {
    usage();
  } else if (!file) {
    file = arg;
  } else {
    usage();
  }
}
if (!file) usage();

const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
// Convenience defaults the agent shouldn't have to invent:
raw.id ??= newArtifactId();
raw.generated_at ??= new Date().toISOString();

const result = validateArtifact(raw);
if (!result.ok) {
  console.error("Artifact failed contract validation:");
  for (const err of result.errors) console.error(`  - ${err}`);
  process.exit(1);
}

const written = await writeArtifact(result.artifact, { outDir });
console.log(`Saved: ${written.jsonPath}`);
