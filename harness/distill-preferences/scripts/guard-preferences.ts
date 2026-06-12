#!/usr/bin/env bun
// guard-preferences.ts — the DETERMINISTIC human-line guard CLI (PR #8 finding
// A). The feed-run recipe BRACKETS the agent's distill task with this guard:
//
//   1. BEFORE the agent's distill: `guard-preferences.ts snapshot`
//        → copies the current PREFERENCES.md to a snapshot file (the pre-write
//          last-known-good). This is the sacrosanct baseline.
//   2. The agent runs distill-preferences (edits [learned] lines).
//   3. AFTER the agent writes, BEFORE generation: `guard-preferences.ts check`
//        → re-reads PREFERENCES.md, asserts EVERY human (non-[learned]) line
//          survived unchanged + in order. If any human line was edited / removed
//          / added / reordered: RESTORE PREFERENCES.md from the snapshot, print
//          a LOUD error, and exit non-zero. A legit [learned]-only change passes
//          and the snapshot is cleaned up.
//
// The decision logic is in preferences-guard-lib.ts (pure + tested); this file
// is the file I/O + exit codes. No model calls — pure plumbing.
//
// Usage:
//   bun .../guard-preferences.ts snapshot [--preferences PATH] [--snapshot PATH]
//   bun .../guard-preferences.ts check    [--preferences PATH] [--snapshot PATH] [--keep-snapshot]
//
// Exit codes: 0 = ok (snapshot taken, or check passed); 1 = VIOLATION (human
// line changed; file restored); 2 = usage / I/O error.

import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { checkHumanLinesUnchanged } from "./preferences-guard-lib.ts";

function usage(): never {
  console.error(
    "usage:\n" +
      "  guard-preferences.ts snapshot [--preferences PATH] [--snapshot PATH]\n" +
      "  guard-preferences.ts check    [--preferences PATH] [--snapshot PATH] [--keep-snapshot]",
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const mode = argv[0];
if (mode !== "snapshot" && mode !== "check") usage();

let preferencesPath = "PREFERENCES.md";
let snapshotPath = ".preferences-guard-snapshot.md";
let keepSnapshot = false;

for (let i = 1; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--preferences") preferencesPath = argv[++i] ?? usage();
  else if (arg === "--snapshot") snapshotPath = argv[++i] ?? usage();
  else if (arg === "--keep-snapshot") keepSnapshot = true;
  else usage();
}

if (mode === "snapshot") {
  // Capture the pre-write last-known-good. A missing PREFERENCES.md is an
  // unusual but non-fatal state: snapshot an empty baseline so a later `check`
  // still runs (the agent CREATING the file with only [learned] lines is then
  // legal; any human line it invents would be a "new human line" violation).
  let content: string;
  try {
    content = await readFile(preferencesPath, "utf8");
  } catch {
    content = "";
    console.error(`[guard] WARN: ${preferencesPath} not found — snapshotting an empty baseline`);
  }
  await writeFile(snapshotPath, content, "utf8");
  console.error(`[guard] snapshot taken: ${preferencesPath} → ${snapshotPath}`);
  process.exit(0);
}

// mode === "check"
let before: string;
try {
  before = await readFile(snapshotPath, "utf8");
} catch {
  console.error(
    `[guard] ERROR: no snapshot at ${snapshotPath} — cannot verify the human ` +
      `lines. Run \`guard-preferences.ts snapshot\` BEFORE the distill. Refusing ` +
      `to pass an unguarded write.`,
  );
  process.exit(2);
}

let after: string;
try {
  after = await readFile(preferencesPath, "utf8");
} catch {
  // The agent DELETED PREFERENCES.md — that is itself a human-line violation
  // (every human line removed). Restore from the snapshot.
  console.error(`[guard] ${preferencesPath} missing after distill — treating as full removal`);
  after = "";
}

const result = checkHumanLinesUnchanged(before, after);

if (result.ok) {
  console.error(
    `[guard] OK: human lines intact (${result.beforeCount} non-[learned] line(s) ` +
      `unchanged); [learned]-only change accepted`,
  );
  if (!keepSnapshot) await rm(snapshotPath, { force: true });
  process.exit(0);
}

// VIOLATION — restore the pre-write file and log LOUDLY.
await copyFile(snapshotPath, preferencesPath);
console.error("");
console.error("========================================================================");
console.error("[guard] CARDINAL RULE VIOLATION — agent distill touched a HUMAN line.");
console.error("[guard] PREFERENCES.md has been RESTORED from the pre-distill snapshot.");
console.error("[guard] Only agent-authored `- [learned]` bullets may change in a distill.");
console.error("[guard] Offending change(s):");
for (const v of result.violations) console.error(`[guard]   - ${v}`);
console.error("========================================================================");
console.error("");
if (!keepSnapshot) await rm(snapshotPath, { force: true });
process.exit(1);
