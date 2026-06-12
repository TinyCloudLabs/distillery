#!/usr/bin/env bun
// verify-distill.ts — the DETERMINISTIC post-run distill verification CLI (PR #8
// finding B). The feed-run recipe runs this AFTER the agent's distill task (and
// after the human-line guard) to confirm the distill ACTUALLY happened rather
// than trusting "completed".
//
// It loads the feedback event timestamps, the post-distill PREFERENCES.md
// [learned] fingerprint, and the distill cursor (how far the last verified
// distill consumed the log). Decision logic lives in distill-verify-lib.ts:
//   - no new events since the cursor → PASS (nothing to act on);
//   - new events + ([learned] changed OR an explicit "no change warranted" log)
//     → VERIFIED, advance the cursor;
//   - new events + neither → SILENT SKIP → emit distill_skipped=true and leave
//     the cursor UNCHANGED (pending events stay pending).
//
// Prints a one-line JSON result to stdout for the recipe to fold into the
// run-log (`{ distill_skipped, pending_events, learned_changed, detail }`). The
// cursor is persisted as a side effect (unless --no-write). No model calls.
//
// Usage:
//   bun .../verify-distill.ts --run-id ID
//     [--events feedback/events.jsonl] [--preferences PREFERENCES.md]
//     [--cursor index/distill-cursor.json]
//     [--distill-log PATH]   # scanned for an explicit "no change" line
//     [--no-change]          # force the explicit-no-change signal (test/manual)
//     [--no-write]           # compute + print, but don't persist the cursor

import { readFile, rename } from "node:fs/promises";
import { readEvents } from "../../_shared/lib/feedback.ts";
import {
  emptyCursor,
  learnedFingerprint,
  verifyDistill,
  type DistillCursor,
} from "./distill-verify-lib.ts";

function usage(): never {
  console.error(
    "usage: verify-distill.ts --run-id ID [--events PATH] [--preferences PATH] " +
      "[--cursor PATH] [--distill-log PATH] [--no-change] [--no-write]",
  );
  process.exit(2);
}

let runId: string | undefined;
let eventsPath = "feedback/events.jsonl";
let preferencesPath = "PREFERENCES.md";
let cursorPath = "index/distill-cursor.json";
let distillLogPath: string | undefined;
let forceNoChange = false;
let noWrite = false;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--run-id") runId = argv[++i] ?? usage();
  else if (arg === "--events") eventsPath = argv[++i] ?? usage();
  else if (arg === "--preferences") preferencesPath = argv[++i] ?? usage();
  else if (arg === "--cursor") cursorPath = argv[++i] ?? usage();
  else if (arg === "--distill-log") distillLogPath = argv[++i] ?? usage();
  else if (arg === "--no-change") forceNoChange = true;
  else if (arg === "--no-write") noWrite = true;
  else usage();
}
if (!runId) usage();

/** Read the persisted cursor, or an empty one (missing/corrupt → empty). */
async function readCursor(path: string): Promise<DistillCursor> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<DistillCursor>;
    if (parsed && typeof parsed === "object") {
      return {
        version: typeof parsed.version === "number" ? parsed.version : 1,
        last_event_ts:
          typeof parsed.last_event_ts === "string" ? parsed.last_event_ts : undefined,
        learned_fingerprint:
          typeof parsed.learned_fingerprint === "string"
            ? parsed.learned_fingerprint
            : undefined,
        last_run_id:
          typeof parsed.last_run_id === "string" ? parsed.last_run_id : undefined,
        updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : undefined,
      };
    }
  } catch {
    // missing / corrupt → empty (treat everything as new; conservative).
  }
  return emptyCursor();
}

/** Atomic write (tmp + rename), the surfaced-ledger pattern. */
async function writeCursor(path: string, cursor: DistillCursor): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(cursor, null, 2) + "\n");
  await rename(tmp, path);
}

/**
 * Detect an explicit "no change warranted" decision in the distill-log, if one
 * was supplied. Deterministic substring scan (case-insensitive) for the agreed
 * marker phrases — the recipe / agent writes one of these when it judged the
 * pending events below the ≥2-signal bar. Missing log → no signal.
 */
async function scanNoChange(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return false;
  }
  const hay = text.toLowerCase();
  return (
    hay.includes("no change warranted") ||
    hay.includes("no changes warranted") ||
    hay.includes("distill: no change") ||
    hay.includes("below threshold")
  );
}

const events = await readEvents(eventsPath);
const eventTimestamps = events.map((e) => e.ts);

let preferences = "";
try {
  preferences = await readFile(preferencesPath, "utf8");
} catch {
  // No PREFERENCES.md → empty fingerprint (the guard handles the human-line
  // side; here an empty file just means "no [learned] lines").
}

const cursor = await readCursor(cursorPath);
const explicitNoChangeLogged = forceNoChange || (await scanNoChange(distillLogPath));

const result = verifyDistill(
  {
    eventTimestamps,
    cursor,
    learnedFingerprintAfter: learnedFingerprint(preferences),
    explicitNoChangeLogged,
  },
  runId,
);

if (!noWrite) {
  await writeCursor(cursorPath, result.nextCursor);
}

if (result.distillSkipped) {
  console.error(`[verify-distill] FLAG distill_skipped=true — ${result.detail}`);
} else {
  console.error(`[verify-distill] ok — ${result.detail}`);
}

// One-line JSON to stdout for the recipe to fold into the run-log.
console.log(
  JSON.stringify({
    distill_skipped: result.distillSkipped,
    pending_events: result.pendingEvents,
    learned_changed: result.learnedChanged,
    detail: result.detail,
  }),
);
