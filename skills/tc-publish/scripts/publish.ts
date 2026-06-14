#!/usr/bin/env bun
// publish.ts — CLI entry for tc-publish. Publish a saved distillery artifact
// (the artifact.json a generation skill produced, plus its media siblings) to
// the hosted `applications` space: KV media first, then the SQL `feed` row.
//
// Usage:
//   bun skills/tc-publish/scripts/publish.ts <artifact-dir> [--space applications]
//
// --space defaults to the profile's configured default space.
// The publisher DID is read from the active profile (audit / replication
// identity column) — override with --publisher-did for tests.
//
// On SPACE_NOT_HOSTED / AUTH_UNAUTHORIZED the underlying tc call throws with
// the exact §3.4 remediation hint; we print it and exit non-zero. No fallback.

import { tcJson, TcCliError } from "../../_shared/lib/tc.ts";
import { loadArtifact, publishArtifact } from "./publish-lib.ts";

function usage(): never {
  console.error(
    "usage: bun skills/tc-publish/scripts/publish.ts <artifact-dir> [--space SPACE] [--publisher-did DID]",
  );
  process.exit(2);
}

let artifactDir: string | undefined;
let space: string | undefined;
let publisherDid: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--space") {
    space = args[++i];
    if (!space || space.startsWith("--")) usage();
  } else if (arg === "--publisher-did") {
    publisherDid = args[++i];
    if (!publisherDid || publisherDid.startsWith("--")) usage();
  } else if (arg.startsWith("--")) {
    usage();
  } else if (!artifactDir) {
    artifactDir = arg;
  } else {
    usage();
  }
}
if (!artifactDir) usage();

/** Read the active profile's DID for the publisher_did audit column. */
async function resolvePublisherDid(): Promise<string> {
  if (publisherDid) return publisherDid;
  const profile = await tcJson<{ did?: string }>(["profile", "show"]);
  if (!profile.did) {
    throw new Error("could not resolve publisher DID from active profile");
  }
  return profile.did;
}

try {
  const artifact = await loadArtifact(artifactDir);
  const did = await resolvePublisherDid();
  const result = await publishArtifact(artifact, artifactDir, {
    space,
    publisherDid: did,
  });
  console.log(
    `Published ${result.id} (type=${artifact.type} render=${result.render_type} slug=${result.slug})`,
  );
  if (result.heroKey) console.log(`  hero  → ${result.heroKey}`);
  if (result.audioKey) console.log(`  audio → ${result.audioKey}`);
  console.log(`  feed row upserted (changes=${result.sqlChanges})`);
} catch (e) {
  if (e instanceof TcCliError) {
    console.error(`\ntc error [${e.code}]: ${e.message}`);
    if (e.hint) console.error(`hint: ${e.hint}`);
    process.exit(1);
  }
  console.error(`tc-publish: ${(e as Error).message}`);
  process.exit(1);
}
