// generate-progress.test.ts — the REAL staged-progress aggregation behind GET
// /api/generate/:run_id (replaces the indefinite spinner). Covers the three
// signals + failure/staleness:
//
//   1. STAGE TRACK   — stages built from a fixture run-log.json's steps[].
//   2. ARTIFACT COUNT — artifact.json files newer than started_at, vs cap.
//   3. ACTIVITY LINE  — the last well-formed progress.jsonl line (and graceful
//      degrade to null when the file is absent/garbage).
//   FAILED   — a failed status.json / aborted run-log surfaces as `failed`
//              (kills the eternal-'running' dead-run bug).
//   STALLED  — running but no signal for > STALE_AFTER_MS → `stalled`.
//   Path-safety on :run_id is preserved (a traversal id → null/failed, never a read).

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRunProgress,
  buildStages,
  tailProgressLine,
  countArtifactsSince,
  PROGRESS_STEPS,
  STALE_AFTER_MS,
  DEFAULT_RUN_CAP,
} from "../src/generate.ts";

let repoRoot: string;
let runsDir: string;
let artifactsDir: string;

const STARTED = "2026-06-11T07:00:00.000Z";
const STARTED_MS = Date.parse(STARTED);

async function stampStatus(runId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const runDir = join(runsDir, runId.replace(/[:]/g, "-"));
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "status.json"),
    JSON.stringify({ run_id: runId, status: "running", dry_run: false, mode: "daily", started_at: STARTED, ...extra }),
  );
  return runDir;
}

async function writeRunLog(runDir: string, log: Record<string, unknown>): Promise<void> {
  await writeFile(join(runDir, "run-log.json"), JSON.stringify(log));
}

async function writeProgress(runDir: string, lines: string[]): Promise<void> {
  await writeFile(join(runDir, "progress.jsonl"), lines.join("\n") + "\n");
}

/** Write an artifact.json with a controllable mtime. */
async function writeArtifact(type: string, slug: string, mtimeMs: number): Promise<void> {
  const d = join(artifactsDir, type, slug);
  await mkdir(d, { recursive: true });
  const f = join(d, "artifact.json");
  await writeFile(f, JSON.stringify({ id: slug, type, headline: slug }));
  const t = mtimeMs / 1000;
  await utimes(f, t, t);
}

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "distillery-prog-"));
  runsDir = join(repoRoot, "index", "runs");
  artifactsDir = join(repoRoot, "artifacts");
  await mkdir(runsDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

// ===========================================================================
// UNIT: buildStages — canonical pipeline + run-log merge + active cursor
// ===========================================================================
describe("buildStages", () => {
  test("with no logged steps, all stages pending and the FIRST is active (running)", () => {
    const { stages, current } = buildStages(undefined, false);
    expect(stages.map((s) => s.step)).toEqual([...PROGRESS_STEPS]);
    expect(stages[0]!.status).toBe("active");
    expect(stages.slice(1).every((s) => s.status === "pending")).toBe(true);
    expect(current).toBe("index");
  });

  test("completed steps tick; the first non-terminal becomes the active cursor", () => {
    const { stages, current } = buildStages(
      [
        { step: "index", status: "ok" },
        { step: "distill", status: "ok" },
        { step: "query-recency", status: "skipped" },
      ],
      false,
    );
    expect(stages.find((s) => s.step === "index")!.status).toBe("ok");
    expect(stages.find((s) => s.step === "query-recency")!.status).toBe("skipped");
    // query-deepdive is the first unlogged step → active.
    expect(current).toBe("query-deepdive");
    expect(stages.find((s) => s.step === "query-deepdive")!.status).toBe("active");
  });

  test("a terminal run marks NO active stage", () => {
    const { stages, current } = buildStages([{ step: "index", status: "ok" }], true);
    expect(current).toBeNull();
    expect(stages.some((s) => s.status === "active")).toBe(false);
  });
});

// ===========================================================================
// UNIT: tailProgressLine — last well-formed line, graceful over garbage
// ===========================================================================
describe("tailProgressLine", () => {
  test("returns the LAST well-formed line's detail", () => {
    const body =
      `{"ts":"2026-06-11T07:01:00Z","detail":"surveying transcripts"}\n` +
      `{"ts":"2026-06-11T07:02:00Z","detail":"drafting insight-card"}\n`;
    expect(tailProgressLine(body)?.detail).toBe("drafting insight-card");
  });

  test("skips a trailing garbage line and finds the last good one", () => {
    const body =
      `{"ts":"t","detail":"critic pass"}\n` + `not json at all\n` + `\n`;
    expect(tailProgressLine(body)?.detail).toBe("critic pass");
  });

  test("empty / all-garbage body → null (graceful)", () => {
    expect(tailProgressLine("")).toBeNull();
    expect(tailProgressLine("garbage\n{bad}\n")).toBeNull();
    expect(tailProgressLine(`{"ts":"t"}\n`)).toBeNull(); // no detail field
  });
});

// ===========================================================================
// UNIT: countArtifactsSince — only artifact.json newer than started_at
// ===========================================================================
describe("countArtifactsSince", () => {
  test("counts only artifacts at/after the cutoff", async () => {
    await writeArtifact("insight-card", "old", STARTED_MS - 60_000); // before
    await writeArtifact("insight-card", "fresh-a", STARTED_MS + 10_000); // after
    await writeArtifact("article", "fresh-b", STARTED_MS + 20_000); // after
    const r = await countArtifactsSince(artifactsDir, STARTED_MS);
    expect(r.count).toBe(2);
    // newest mtime is the later of the two fresh artifacts (folded into staleness).
    expect(r.newestMtimeMs).toBe(STARTED_MS + 20_000);
  });

  test("missing artifacts dir → 0 (never throws)", async () => {
    const r = await countArtifactsSince(join(repoRoot, "nope"), STARTED_MS);
    expect(r.count).toBe(0);
    expect(r.newestMtimeMs).toBe(0);
  });

  test("ignores dirs without an artifact.json", async () => {
    await mkdir(join(artifactsDir, "insight-card", "empty"), { recursive: true });
    const r = await countArtifactsSince(artifactsDir, STARTED_MS);
    expect(r.count).toBe(0);
  });
});

// ===========================================================================
// INTEGRATION: readRunProgress — the full aggregation
// ===========================================================================
describe("readRunProgress — running with all three signals", () => {
  test("stages from run-log, fresh artifact count, activity tail, elapsed", async () => {
    const runId = STARTED;
    const runDir = await stampStatus(runId);
    await writeRunLog(runDir, {
      cap: 3,
      steps: [
        { step: "index", status: "ok" },
        { step: "distill", status: "ok" },
        { step: "query-recency", status: "ok" },
        { step: "query-deepdive", status: "ok" },
        { step: "brief", status: "ok" },
        { step: "generate", status: "active" },
      ],
      // no outcome yet → still running
    });
    await writeProgress(runDir, [
      `{"ts":"t1","detail":"surveying transcripts"}`,
      `{"ts":"t2","detail":"drafting insight-card"}`,
    ]);
    await writeArtifact("insight-card", "card-1", STARTED_MS + 30_000);

    const now = () => STARTED_MS + 90_000; // 90s elapsed
    const p = await readRunProgress(runId, { repoRoot, runsDir, artifactsDir }, now);

    expect(p.status).toBe("running");
    expect(p.cap).toBe(3);
    expect(p.artifacts_produced).toBe(1);
    expect(p.latest_activity).toBe("drafting insight-card");
    expect(p.current_stage).toBe("generate");
    expect(p.stages.find((s) => s.step === "generate")!.status).toBe("active");
    expect(p.elapsed_ms).toBe(90_000);
    expect(p.done).toBe(false);
  });
});

describe("readRunProgress — graceful degrade with NO progress.jsonl", () => {
  test("latest_activity is null but stages + count still resolve", async () => {
    const runId = STARTED;
    const runDir = await stampStatus(runId);
    await writeRunLog(runDir, { cap: 3, steps: [{ step: "index", status: "ok" }] });
    // no progress.jsonl, no artifacts
    const p = await readRunProgress(runId, { repoRoot, runsDir, artifactsDir }, () => STARTED_MS + 5_000);
    expect(p.latest_activity).toBeNull();
    expect(p.status).toBe("running");
    expect(p.stages.find((s) => s.step === "index")!.status).toBe("ok");
    expect(p.current_stage).toBe("distill"); // first unlogged → active
  });

  test("no run-log at all → full pending pipeline, first stage active", async () => {
    const runId = STARTED;
    await stampStatus(runId);
    const p = await readRunProgress(runId, { repoRoot, runsDir, artifactsDir }, () => STARTED_MS + 1_000);
    expect(p.status).toBe("running");
    expect(p.cap).toBe(DEFAULT_RUN_CAP);
    expect(p.current_stage).toBe("index");
    expect(p.stages[0]!.status).toBe("active");
    expect(p.latest_activity).toBeNull();
  });
});

describe("readRunProgress — done", () => {
  test("run-log outcome completed → done + published artifacts", async () => {
    const runId = STARTED;
    const runDir = await stampStatus(runId);
    await writeRunLog(runDir, {
      cap: 3,
      outcome: "completed",
      artifacts_published: ["insight-card/foo", "article/bar"],
      drafts_produced: ["social-post/baz"],
      steps: [
        { step: "index", status: "ok" },
        { step: "generate", status: "ok" },
        { step: "save", status: "ok" },
      ],
    });
    const p = await readRunProgress(runId, { repoRoot, runsDir, artifactsDir }, () => STARTED_MS + 200_000);
    expect(p.status).toBe("done");
    expect(p.done).toBe(true);
    expect(p.current_stage).toBeNull();
    expect(p.artifacts_published).toEqual(["insight-card/foo", "article/bar"]);
    expect(p.drafts_produced).toBe(1);
  });
});

describe("readRunProgress — FAILED surfaces (no eternal running)", () => {
  test("a run-log outcome 'aborted' → failed", async () => {
    const runId = STARTED;
    const runDir = await stampStatus(runId);
    await writeRunLog(runDir, { outcome: "aborted", steps: [{ step: "index", status: "aborted" }] });
    const p = await readRunProgress(runId, { repoRoot, runsDir, artifactsDir }, () => STARTED_MS + 5_000);
    expect(p.status).toBe("failed");
    expect(p.done).toBe(true);
  });

  test("a status.json marked status:'failed' → failed (dead-run bug)", async () => {
    const runId = STARTED;
    await stampStatus(runId, { status: "failed" });
    const p = await readRunProgress(runId, { repoRoot, runsDir, artifactsDir }, () => STARTED_MS + 5_000);
    expect(p.status).toBe("failed");
    expect(p.done).toBe(true);
  });
});

describe("readRunProgress — STALLED detection", () => {
  test("running but no signal for > STALE_AFTER_MS → stalled (not running, not done)", async () => {
    const runId = STARTED;
    const runDir = await stampStatus(runId);
    await writeRunLog(runDir, { cap: 3, steps: [{ step: "index", status: "ok" }] });
    // Backdate every signal file so the freshest mtime is well in the past.
    const old = (STARTED_MS - STALE_AFTER_MS) / 1000;
    await utimes(join(runDir, "status.json"), old, old);
    await utimes(join(runDir, "run-log.json"), old, old);
    const now = () => STARTED_MS + STALE_AFTER_MS + 60_000;
    const p = await readRunProgress(runId, { repoRoot, runsDir, artifactsDir }, now);
    expect(p.status).toBe("stalled");
    expect(p.done).toBe(false); // stalled is NOT terminal-done; UI offers retry
  });

  test("a FRESH run-log mtime keeps it running even past STALE_AFTER_MS wall time", async () => {
    const runId = STARTED;
    const runDir = await stampStatus(runId);
    await writeRunLog(runDir, { cap: 3, steps: [{ step: "index", status: "ok" }] });
    // run-log mtime is "now" (fresh) → not stale even though started long ago.
    const now = () => STARTED_MS + STALE_AFTER_MS + 60_000;
    const freshMs = now() - 1000;
    const fresh = freshMs / 1000;
    await utimes(join(runDir, "run-log.json"), fresh, fresh);
    await utimes(join(runDir, "status.json"), fresh, fresh);
    const p = await readRunProgress(runId, { repoRoot, runsDir, artifactsDir }, now);
    expect(p.status).toBe("running");
  });

  test("a FRESH ARTIFACT keeps a long generate running even when run-log/status are stale (review #3b)", async () => {
    // The failure the review flagged: a healthy multi-artifact generate that
    // hasn't bumped run-log/status for > STALE_AFTER_MS, but IS still landing
    // artifacts, was false-stalled because artifact mtimes were never folded into
    // `freshest`. Now they are.
    const runId = STARTED;
    const runDir = await stampStatus(runId);
    await writeRunLog(runDir, { cap: 3, steps: [{ step: "generate", status: "active" }] });
    const now = () => STARTED_MS + STALE_AFTER_MS + 60_000;
    // Backdate run-log + status so they alone would trip the stall threshold.
    const stale = (STARTED_MS - 60_000) / 1000;
    await utimes(join(runDir, "run-log.json"), stale, stale);
    await utimes(join(runDir, "status.json"), stale, stale);
    // But a fresh artifact landed seconds ago → the run is demonstrably alive.
    await writeArtifact("insight-card", "just-shipped", now() - 5_000);
    const p = await readRunProgress(runId, { repoRoot, runsDir, artifactsDir }, now);
    expect(p.status).toBe("running"); // NOT stalled — the artifact is liveness
    expect(p.artifacts_produced).toBe(1);
  });
});

describe("readRunProgress — path-safety preserved", () => {
  test("a traversal run_id → failed/empty, never reads outside runsDir", async () => {
    const p = await readRunProgress("../../secret", { repoRoot, runsDir, artifactsDir }, () => STARTED_MS);
    expect(p.status).toBe("failed");
    expect(p.started_at).toBe("");
    expect(p.artifacts_produced).toBe(0);
  });
});
