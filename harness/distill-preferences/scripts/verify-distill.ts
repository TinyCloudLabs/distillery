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
//   - new events + [learned] changed → VERIFIED, advance the cursor;
//   - new events + a "no change warranted" log THAT THE AGGREGATE CORROBORATES
//     (no pending grouping clears the ≥2-signal bar) → VERIFIED, advance;
//   - new events + a "no change" claim the aggregate CONTRADICTS (a grouping
//     clears the bar but [learned] is unchanged) → SKIP flagged (the agent
//     can't grade its own homework with a free-text phrase — MEDIUM fix);
//   - new events + neither → SILENT SKIP → emit distill_skipped=true and leave
//     the cursor UNCHANGED (pending events stay pending).
//
// The no-change CORROBORATION re-runs the same `summarize-events` aggregate the
// distill agent reads, restricted to the PENDING (un-cursored) events, and
// checks the generalizable-signal count of every grouping against the ≥2 bar.
//
// Prints a one-line JSON result to stdout for the recipe to fold into the
// run-log (`{ distill_skipped, pending_events, learned_changed, detail }`). The
// cursor is persisted as a side effect (unless --no-write). No model calls.
//
// Usage:
//   bun .../verify-distill.ts --run-id ID
//     [--events feedback/events.jsonl] [--preferences PREFERENCES.md]
//     [--cursor index/distill-cursor.json] [--artifacts-dir artifacts]
//     [--distill-log PATH]   # scanned for an explicit "no change" line
//     [--no-change]          # force the explicit-no-change signal (test/manual)
//     [--no-write]           # compute + print, but don't persist the cursor

import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  readEvents,
  summarizeEvents,
  type FeedbackArtifactRef,
  type FeedbackEvent,
} from "../../../skills/_shared/lib/feedback.ts";
import {
  aggregateBelowThreshold as computeBelowThreshold,
  emptyCursor,
  learnedFingerprint,
  newEventsSince,
  verifyDistill,
  type DistillCursor,
} from "./distill-verify-lib.ts";

function usage(): never {
  console.error(
    "usage: verify-distill.ts --run-id ID [--events PATH] [--preferences PATH] " +
      "[--cursor PATH] [--artifacts-dir PATH] [--distill-log PATH] [--no-change] [--no-write]",
  );
  process.exit(2);
}

let runId: string | undefined;
let eventsPath = "feedback/events.jsonl";
let preferencesPath = "PREFERENCES.md";
let cursorPath = "index/distill-cursor.json";
let artifactsDir = "artifacts";
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
  else if (arg === "--artifacts-dir") artifactsDir = argv[++i] ?? usage();
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
 * Detect an explicit "no change warranted" CLAIM in the distill-log, if one was
 * supplied. Deterministic substring scan (case-insensitive) for the agreed
 * marker phrases. NOTE: this is the agent's self-attestation only — by itself it
 * does NOT clear a skip. The claim is honored as a valid no-op ONLY when the
 * deterministic aggregate also shows no pending grouping reaches the ≥2-signal
 * bar (see verifyDistill / aggregateBelowThreshold). Missing log → no claim.
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

/**
 * artifacts/<type>/<slug>/artifact.json → refs for the tag/headline join, so the
 * pending-event aggregate groups by tag too (same join summarize-events does).
 * Best-effort: a missing/unreadable dir yields no refs (groupings fall back to
 * artifact + type, which is enough to detect a ≥2-signal grouping).
 */
async function scanArtifactRefs(dir: string): Promise<FeedbackArtifactRef[]> {
  const refs: FeedbackArtifactRef[] = [];
  const listDirs = async (path: string): Promise<string[]> => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const type of await listDirs(dir)) {
    for (const slug of await listDirs(join(dir, type))) {
      try {
        const raw = JSON.parse(
          await readFile(join(dir, type, slug, "artifact.json"), "utf8"),
        ) as Record<string, unknown>;
        if (typeof raw.id !== "string") continue;
        refs.push({
          id: raw.id,
          type: typeof raw.type === "string" ? raw.type : type,
          tags: Array.isArray(raw.tags)
            ? raw.tags.filter((t): t is string => typeof t === "string")
            : [],
        });
      } catch {
        // malformed artifact — skip, never fatal
      }
    }
  }
  return refs;
}

/**
 * DETERMINISTIC ≥2-signal-bar corroboration over the PENDING events (finding B /
 * MEDIUM fix). Re-runs the same aggregation the distill agent reads, restricted
 * to events newer than the cursor, and returns the GENERALIZABLE-signal count
 * for each grouping (per artifact, per type, per tag). `save` is excluded — it
 * is a per-instance utility signal that the distillation keeps instance-level
 * (SKILL §3), never a generalization driver. The lib then checks max < 2.
 */
function pendingGroupSignalCounts(
  pending: FeedbackEvent[],
  refs: FeedbackArtifactRef[],
): number[] {
  const summary = summarizeEvents(pending, refs);
  // Generalizable signals = all actions except `save` (instance-level utility).
  const generalizable = (a: { more: number; less: number; already_knew: number; wrong: number; promote: number }) =>
    a.more + a.less + a.already_knew + a.wrong + a.promote;
  return [
    ...summary.by_artifact.map((r) => generalizable(r.actions)),
    ...summary.by_type.map((r) => generalizable(r.actions)),
    ...summary.by_tag.map((r) => generalizable(r.actions)),
  ];
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

// Corroborate any no-change claim against the deterministic aggregate of the
// PENDING events (finding B / MEDIUM fix) — the agent can't pass a skip with a
// free-text phrase if a grouping actually clears the ≥2-signal bar.
const pending = events.filter((e) => {
  // newEventsSince's per-event cutoff logic, inlined: strictly newer than the
  // cursor (or unparseable, conservatively counted as pending) → this event is
  // un-distilled. An undefined cursor means everything is pending.
  return newEventsSince([e.ts], cursor.last_event_ts) === 1;
});
const refs = await scanArtifactRefs(artifactsDir);
const aggregateBelow = computeBelowThreshold(pendingGroupSignalCounts(pending, refs));

const result = verifyDistill(
  {
    eventTimestamps,
    cursor,
    learnedFingerprintAfter: learnedFingerprint(preferences),
    explicitNoChangeLogged,
    aggregateBelowThreshold: aggregateBelow,
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
