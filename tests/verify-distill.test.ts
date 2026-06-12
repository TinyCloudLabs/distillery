// verify-distill.test.ts — the DETERMINISTIC post-run distill verification (PR
// #8 finding B). Unit tests on the pure lib + end-to-end CLI tests proving:
// distill ran (learned changed) → verified + cursor advances; distill skipped
// with pending events → distill_skipped=true + cursor UNCHANGED; explicit
// "no change warranted" with pending events → verified; no pending events → pass.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  aggregateBelowThreshold,
  emptyCursor,
  learnedFingerprint,
  newEventsSince,
  newestEventTs,
  SIGNAL_THRESHOLD,
  verifyDistill,
  type DistillCursor,
} from "../harness/distill-preferences/scripts/distill-verify-lib.ts";

const CLI = resolve(
  import.meta.dir,
  "../harness/distill-preferences/scripts/verify-distill.ts",
);

// ---------------------------------------------------------------------------
// pure lib
// ---------------------------------------------------------------------------

describe("learnedFingerprint", () => {
  test("is order-independent over [learned] bullets, ignores human lines", () => {
    const a = ["## Topics", "- [learned] X (1, Jun)", "- human", "- [learned] Y (2, Jun)"].join("\n");
    const b = ["- [learned] Y (2, Jun)", "junk human", "- [learned] X (1, Jun)"].join("\n");
    expect(learnedFingerprint(a)).toBe(learnedFingerprint(b));
  });
  test("changes when a learned bullet is added/edited/removed", () => {
    const a = ["- [learned] X (1, Jun)"].join("\n");
    const edited = ["- [learned] X (5, Jun)"].join("\n");
    const added = ["- [learned] X (1, Jun)", "- [learned] Z (1, Jun)"].join("\n");
    expect(learnedFingerprint(a)).not.toBe(learnedFingerprint(edited));
    expect(learnedFingerprint(a)).not.toBe(learnedFingerprint(added));
  });
});

describe("newEventsSince / newestEventTs", () => {
  const ts = [
    "2026-06-11T23:25:52.574Z",
    "2026-06-12T01:25:08.516Z",
    "2026-06-12T01:54:13.793Z",
  ];
  test("undefined cursor → everything is new", () => {
    expect(newEventsSince(ts, undefined)).toBe(3);
  });
  test("counts only events strictly newer than the cursor (by instant)", () => {
    expect(newEventsSince(ts, "2026-06-12T01:25:08.516Z")).toBe(1);
    expect(newEventsSince(ts, "2026-06-12T01:54:13.793Z")).toBe(0);
  });
  test("newest by instant, not lexically", () => {
    expect(newestEventTs(ts)).toBe("2026-06-12T01:54:13.793Z");
    expect(newestEventTs([])).toBeUndefined();
  });
});

describe("aggregateBelowThreshold", () => {
  test("empty / all-below-bar groupings → below threshold (no-change corroborated)", () => {
    expect(aggregateBelowThreshold([])).toBe(true);
    expect(aggregateBelowThreshold([0, 1, 1])).toBe(true);
  });
  test("any grouping at/above the ≥2 bar → NOT below (a preference was distillable)", () => {
    expect(aggregateBelowThreshold([1, SIGNAL_THRESHOLD])).toBe(false);
    expect(aggregateBelowThreshold([5])).toBe(false);
  });
});

describe("verifyDistill (decision table)", () => {
  const events = ["2026-06-11T23:00:00Z", "2026-06-12T01:00:00Z"];

  test("pending events + [learned] changed → VERIFIED, cursor advances", () => {
    const cursor: DistillCursor = {
      version: 1,
      last_event_ts: "2026-06-11T23:00:00Z", // 1 pending (01:00)
      learned_fingerprint: "old",
    };
    const r = verifyDistill(
      {
        eventTimestamps: events,
        cursor,
        learnedFingerprintAfter: "new",
        explicitNoChangeLogged: false,
        aggregateBelowThreshold: false,
      },
      "run-1",
    );
    expect(r.distillSkipped).toBe(false);
    expect(r.pendingEvents).toBe(1);
    expect(r.learnedChanged).toBe(true);
    expect(r.nextCursor.last_event_ts).toBe("2026-06-12T01:00:00Z");
    expect(r.nextCursor.learned_fingerprint).toBe("new");
  });

  test("pending events + NO change + NO explicit log → SKIP flagged, cursor UNCHANGED", () => {
    const cursor: DistillCursor = {
      version: 1,
      last_event_ts: "2026-06-11T23:00:00Z",
      learned_fingerprint: "same",
    };
    const r = verifyDistill(
      {
        eventTimestamps: events,
        cursor,
        learnedFingerprintAfter: "same",
        explicitNoChangeLogged: false,
        aggregateBelowThreshold: true,
      },
      "run-2",
    );
    expect(r.distillSkipped).toBe(true);
    expect(r.pendingEvents).toBe(1);
    expect(r.nextCursor).toEqual(cursor); // not advanced — events stay pending
  });

  test("explicit 'no change' + aggregate CORROBORATES (below bar) → VERIFIED, cursor advances", () => {
    const cursor: DistillCursor = {
      version: 1,
      last_event_ts: "2026-06-11T23:00:00Z",
      learned_fingerprint: "same",
    };
    const r = verifyDistill(
      {
        eventTimestamps: events,
        cursor,
        learnedFingerprintAfter: "same",
        explicitNoChangeLogged: true,
        aggregateBelowThreshold: true,
      },
      "run-3",
    );
    expect(r.distillSkipped).toBe(false);
    expect(r.nextCursor.last_event_ts).toBe("2026-06-12T01:00:00Z");
  });

  test("MEDIUM FIX: explicit 'no change' but aggregate CONTRADICTS (≥2 bar cleared, no [learned] delta) → SKIP flagged, cursor UNCHANGED", () => {
    // The foolable case the review reproduced: agent writes "below threshold"
    // while a grouping actually clears the ≥2-signal bar and nothing was
    // distilled. The free-text phrase no longer passes — the math wins.
    const cursor: DistillCursor = {
      version: 1,
      last_event_ts: "2026-06-11T23:00:00Z",
      learned_fingerprint: "same",
    };
    const r = verifyDistill(
      {
        eventTimestamps: events,
        cursor,
        learnedFingerprintAfter: "same",
        explicitNoChangeLogged: true,
        aggregateBelowThreshold: false, // a grouping DID clear the bar
      },
      "run-3b",
    );
    expect(r.distillSkipped).toBe(true);
    expect(r.detail).toContain("CONTRADICTED");
    expect(r.nextCursor).toEqual(cursor); // backlog NOT burned
  });

  test("NO pending events → pass (nothing to act on), cursor refreshed not flagged", () => {
    const cursor: DistillCursor = {
      version: 1,
      last_event_ts: "2026-06-12T01:00:00Z", // already at newest
      learned_fingerprint: "x",
    };
    const r = verifyDistill(
      {
        eventTimestamps: events,
        cursor,
        learnedFingerprintAfter: "x",
        explicitNoChangeLogged: false,
        aggregateBelowThreshold: true,
      },
      "run-4",
    );
    expect(r.distillSkipped).toBe(false);
    expect(r.pendingEvents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// end-to-end CLI (events.jsonl + PREFERENCES.md + cursor file)
// ---------------------------------------------------------------------------

let dir: string;
let eventsPath: string;
let prefsPath: string;
let cursorPath: string;

const EVENTS = [
  { artifact_id: "a", artifact_type: "insight-card", action: "more", ts: "2026-06-11T23:00:00Z" },
  { artifact_id: "a", artifact_type: "insight-card", action: "save", ts: "2026-06-12T01:00:00Z" },
];

const PREFS_BEFORE = ["## Topics", "- human line", "- [learned] old (1 more, Jun 2026)"].join("\n");
const PREFS_AFTER = ["## Topics", "- human line", "- [learned] NEW (5 more, Jun 2026)"].join("\n");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "distillery-verify-"));
  eventsPath = join(dir, "events.jsonl");
  prefsPath = join(dir, "PREFERENCES.md");
  cursorPath = join(dir, "distill-cursor.json");
  await writeFile(eventsPath, EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("verify-distill CLI", () => {
  test("distill ran (learned changed) → distill_skipped=false + cursor persisted at newest event", async () => {
    // First run with no cursor: establish baseline by writing PREFS_BEFORE and
    // having the agent change it to PREFS_AFTER.
    await writeFile(prefsPath, PREFS_AFTER, "utf8");
    const r = await runCli([
      "--run-id", "run-1",
      "--events", eventsPath,
      "--preferences", prefsPath,
      "--cursor", cursorPath,
    ]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as { distill_skipped: boolean; pending_events: number };
    expect(out.distill_skipped).toBe(false);
    expect(out.pending_events).toBe(2); // no prior cursor → all new
    const cursor = JSON.parse(await readFile(cursorPath, "utf8")) as DistillCursor;
    expect(cursor.last_event_ts).toBe("2026-06-12T01:00:00Z");
  });

  test("distill SKIPPED with pending events → distill_skipped=true + cursor NOT advanced", async () => {
    // Seed a cursor reflecting a PRIOR distill at PREFS_BEFORE, consuming only
    // the first event — so the second event is pending.
    const seeded: DistillCursor = {
      version: 1,
      last_event_ts: "2026-06-11T23:00:00Z",
      learned_fingerprint: learnedFingerprint(PREFS_BEFORE),
    };
    await writeFile(cursorPath, JSON.stringify(seeded), "utf8");
    // Agent does NOT change [learned] lines this run (PREFS stays at _BEFORE).
    await writeFile(prefsPath, PREFS_BEFORE, "utf8");

    const r = await runCli([
      "--run-id", "run-2",
      "--events", eventsPath,
      "--preferences", prefsPath,
      "--cursor", cursorPath,
    ]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as { distill_skipped: boolean; pending_events: number };
    expect(out.distill_skipped).toBe(true);
    expect(out.pending_events).toBe(1);
    expect(r.stderr).toContain("distill_skipped=true");
    // cursor unchanged — the pending event stays pending
    const cursor = JSON.parse(await readFile(cursorPath, "utf8")) as DistillCursor;
    expect(cursor.last_event_ts).toBe("2026-06-11T23:00:00Z");
  });

  test("--no-change (explicit no-change) with pending events → verified (not skipped)", async () => {
    const seeded: DistillCursor = {
      version: 1,
      last_event_ts: "2026-06-11T23:00:00Z",
      learned_fingerprint: learnedFingerprint(PREFS_BEFORE),
    };
    await writeFile(cursorPath, JSON.stringify(seeded), "utf8");
    await writeFile(prefsPath, PREFS_BEFORE, "utf8");

    const r = await runCli([
      "--run-id", "run-3",
      "--events", eventsPath,
      "--preferences", prefsPath,
      "--cursor", cursorPath,
      "--no-change",
    ]);
    const out = JSON.parse(r.stdout.trim()) as { distill_skipped: boolean };
    expect(out.distill_skipped).toBe(false);
    // cursor advances even though [learned] did not change (valid no-op)
    const cursor = JSON.parse(await readFile(cursorPath, "utf8")) as DistillCursor;
    expect(cursor.last_event_ts).toBe("2026-06-12T01:00:00Z");
  });

  test("explicit no-change detected from a distill-log file → verified", async () => {
    const seeded: DistillCursor = {
      version: 1,
      last_event_ts: "2026-06-11T23:00:00Z",
      learned_fingerprint: learnedFingerprint(PREFS_BEFORE),
    };
    await writeFile(cursorPath, JSON.stringify(seeded), "utf8");
    await writeFile(prefsPath, PREFS_BEFORE, "utf8");
    const logPath = join(dir, "generation-log.txt");
    await writeFile(logPath, "ran distill-preferences: no change warranted, 1 event below threshold\n", "utf8");

    const r = await runCli([
      "--run-id", "run-4",
      "--events", eventsPath,
      "--preferences", prefsPath,
      "--cursor", cursorPath,
      "--distill-log", logPath,
    ]);
    const out = JSON.parse(r.stdout.trim()) as { distill_skipped: boolean };
    expect(out.distill_skipped).toBe(false);
  });

  test("MEDIUM FIX (e2e): claimed 'below threshold' but ≥2 pending signals on one artifact → distill_skipped=true, cursor NOT advanced", async () => {
    // Reproduce the review's no-op attack end-to-end: a fresh cursor (everything
    // pending), 2 `more` events on the SAME artifact (clears the ≥2-signal bar),
    // NO [learned] change, and a log claiming "below threshold". The aggregate
    // contradicts the claim → the skip is flagged and the backlog is preserved.
    const twoMore = [
      { artifact_id: "z", artifact_type: "insight-card", action: "more", ts: "2026-06-11T23:00:00Z" },
      { artifact_id: "z", artifact_type: "insight-card", action: "more", ts: "2026-06-12T01:00:00Z" },
    ];
    await writeFile(eventsPath, twoMore.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    // Agent did NOT change [learned] — empty prefs, fingerprint matches cursor.
    await writeFile(prefsPath, "## Topics\n- human line\n", "utf8");
    const seeded: DistillCursor = {
      version: 1,
      learned_fingerprint: learnedFingerprint("## Topics\n- human line\n"),
    };
    await writeFile(cursorPath, JSON.stringify(seeded), "utf8");
    const logPath = join(dir, "generation-log.txt");
    await writeFile(logPath, "distill: no change warranted, below threshold\n", "utf8");

    const r = await runCli([
      "--run-id", "run-attack",
      "--events", eventsPath,
      "--preferences", prefsPath,
      "--cursor", cursorPath,
      "--distill-log", logPath,
    ]);
    const out = JSON.parse(r.stdout.trim()) as { distill_skipped: boolean; pending_events: number };
    expect(out.distill_skipped).toBe(true); // phrase no longer fools verify
    expect(out.pending_events).toBe(2);
    // cursor NOT advanced — the 2 pending events stay pending for a real distill
    const cursor = JSON.parse(await readFile(cursorPath, "utf8")) as DistillCursor;
    expect(cursor.last_event_ts).toBeUndefined();
  });

  test("--no-write computes the flag but does not persist the cursor", async () => {
    await writeFile(prefsPath, PREFS_AFTER, "utf8");
    const r = await runCli([
      "--run-id", "run-5",
      "--events", eventsPath,
      "--preferences", prefsPath,
      "--cursor", cursorPath,
      "--no-write",
    ]);
    expect(r.code).toBe(0);
    expect(await readFile(cursorPath, "utf8").catch(() => "MISSING")).toBe("MISSING");
  });
});
