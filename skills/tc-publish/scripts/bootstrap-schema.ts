#!/usr/bin/env bun
// bootstrap-schema.ts — create the three application-space databases with the
// EXACT §1 DDL (artifact-schema.ts). Idempotent: every statement is CREATE …
// IF NOT EXISTS, so this runs safely on every workflow start.
//
// Usage:
//   bun skills/tc-publish/scripts/bootstrap-schema.ts [--space applications]
//
// --space defaults to the profile's configured default space (set once with
// `tc profile set-default-space applications`). Pass --space to override.
//
// On a capability gap the underlying `tc` call throws TcCliError with the
// exact remediation hint (§3.4); we re-throw it verbatim — no fallback to a
// different space, no swallowing.

import {
  ARTIFACT_DBS,
  type ArtifactDb,
} from "../../_shared/lib/artifact-schema.ts";
import { sqlExecute, TcCliError } from "../../_shared/lib/tc.ts";

function parseSpace(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--space") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) {
        console.error("--space requires a value");
        process.exit(2);
      }
      return v;
    }
    console.error(`unknown argument: ${argv[i]}`);
    process.exit(2);
  }
  return undefined;
}

/** Names the index a CREATE INDEX statement defines, for reporting. */
function indexName(statement: string): string {
  return statement.match(/INDEX IF NOT EXISTS (\w+)/)?.[1] ?? statement;
}

async function bootstrapDb(
  dbSpec: ArtifactDb,
  space: string | undefined,
  skippedIndexes: string[],
): Promise<void> {
  // Tables are required — let TcCliError propagate (hard failure).
  for (const statement of dbSpec.tables) {
    await sqlExecute(statement, { db: dbSpec.db, space });
  }
  // Indexes are best-effort: the node's SQLite authorizer rejects CREATE
  // INDEX. Attempt each; on the known "not authorized" rejection, record and
  // continue. Any OTHER error still propagates (we don't mask real problems).
  for (const statement of dbSpec.indexes) {
    try {
      await sqlExecute(statement, { db: dbSpec.db, space });
    } catch (e) {
      if (e instanceof TcCliError && /not authorized/i.test(e.message)) {
        skippedIndexes.push(`${dbSpec.db}: ${indexName(statement)}`);
        continue;
      }
      throw e;
    }
  }
  console.log(
    `  ✓ ${dbSpec.db} (${dbSpec.tables.length} table${dbSpec.tables.length === 1 ? "" : "s"})`,
  );
}

if (import.meta.main) {
  const space = parseSpace(process.argv.slice(2));
  const where = space ? `--space ${space}` : "profile default space";
  console.log(`Bootstrapping artifact schema in ${where}:`);
  const skippedIndexes: string[] = [];
  try {
    for (const dbSpec of ARTIFACT_DBS) {
      await bootstrapDb(dbSpec, space, skippedIndexes);
    }
  } catch (e) {
    if (e instanceof TcCliError) {
      console.error(`\ntc error [${e.code}]: ${e.message}`);
      if (e.hint) console.error(`hint: ${e.hint}`);
      process.exit(1);
    }
    console.error(`bootstrap-schema: ${(e as Error).message}`);
    process.exit(1);
  }

  if (skippedIndexes.length > 0) {
    console.warn(
      `\nNOTE: the node rejected ${skippedIndexes.length} index(es) ` +
        `("CREATE INDEX … not authorized" — a server-side SQLite authorizer ` +
        `constraint, not a capability gap):`,
    );
    for (const idx of skippedIndexes) console.warn(`  - ${idx}`);
    console.warn(
      `These are query accelerators. uq_interaction_nonce's replay protection ` +
        `moves to the distill layer (dedup on (reader_did, nonce, recorded_at)) ` +
        `until the node permits the UNIQUE index.`,
    );
  }
  console.log("\nSchema ready (tables created).");
}
