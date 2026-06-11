// feed-run.test.ts — the feed-run recipe orchestrator (spec §5).
//
// Two layers:
//   1. Pure-lib unit tests (deep-dive ranking, brief render, --since resolution,
//      run-log summary, topic keys) — fast, no subprocesses.
//   2. End-to-end integration tests that run the REAL feed-run.ts CLI against a
//      synthetic corpus in a temp index/ledger, asserting: step ordering in the
//      run-log, --dry-run produces a valid brief, distill-failure degradation
//      (the run continues), the cursor advances across two runs, and the cap is
//      reflected in the brief.
//
// All transcript content here is SYNTHETIC — never real meeting text.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import type { IndexRecord } from "../skills/index-corpus/scripts/corpus-index.ts";
import type { QueryMatch } from "../skills/query-corpus/scripts/corpus-query.ts";
import {
  capForMode,
  ledgerMode,
  MAX_ARTIFACTS_BACKFILL,
  MAX_ARTIFACTS_PER_RUN,
  orderedDeepDivePaths,
  parseRelativeSince,
  PIPELINE_STEPS,
  rankDeepDiveCandidates,
  renderBrief,
  resolveSince,
  summarizeRun,
  toDate,
  topicKeysFor,
  type RunLog,
} from "../skills/feed-run/scripts/feed-run-lib.ts";

const REPO = join(import.meta.dir, "..");

function rec(over: Partial<IndexRecord> & Pick<IndexRecord, "path">): IndexRecord {
  return {
    source: "fireflies",
    title: "Untitled",
    date: "2026-06-01",
    speakers: ["Ada"],
    speakerTurnCounts: { Ada: 1 },
    turnCount: 1,
    entities: [],
    terms: [],
    quantities: [],
    content_hash: "sha256:deadbeef",
    indexed_at: "2026-06-01T00:00:00Z",
    empty: false,
    ...over,
  };
}

function match(over: Partial<QueryMatch> & Pick<QueryMatch, "path">): QueryMatch {
  return {
    source: "fireflies",
    date: "2026-06-08",
    title: "A meeting",
    matched_on: ["since"],
    match_context: [],
    surfaced: false,
    surfaced_by: [],
    ...over,
  };
}

// ===========================================================================
// 1. pure lib
// ===========================================================================

describe("caps + modes", () => {
  test("daily cap is 3, backfill is 25", () => {
    expect(capForMode("daily")).toBe(MAX_ARTIFACTS_PER_RUN);
    expect(capForMode("daily")).toBe(3);
    expect(capForMode("backfill")).toBe(MAX_ARTIFACTS_BACKFILL);
    expect(capForMode("backfill")).toBe(25);
  });

  test("ledgerMode maps daily kinds; backfill always backfill", () => {
    expect(ledgerMode("daily", "recency")).toBe("recency");
    expect(ledgerMode("daily", "deepdive")).toBe("deepdive");
    expect(ledgerMode("backfill", "recency")).toBe("backfill");
    expect(ledgerMode("backfill", "deepdive")).toBe("backfill");
  });
});

describe("--since resolution", () => {
  const now = new Date("2026-06-11T12:00:00Z");

  test("relative windows parse to a date floor", () => {
    expect(parseRelativeSince("14d", now)).toBe("2026-05-28");
    expect(parseRelativeSince("2w", now)).toBe("2026-05-28");
    expect(parseRelativeSince("nonsense", now)).toBeUndefined();
    expect(parseRelativeSince("2026-06-01", now)).toBeUndefined(); // absolute, not relative
  });

  test("explicit absolute wins; else last run; else 7 days", () => {
    expect(resolveSince("2026-06-05", "2026-06-09T00:00:00Z", now)).toBe("2026-06-05");
    expect(resolveSince(undefined, "2026-06-09T08:30:00Z", now)).toBe("2026-06-09");
    expect(resolveSince(undefined, undefined, now)).toBe("2026-06-04"); // 7 days back
  });

  test("toDate coerces iso to YYYY-MM-DD", () => {
    expect(toDate("2026-06-11T14:00:00Z")).toBe("2026-06-11");
    expect(toDate("2026-06-11")).toBe("2026-06-11");
  });
});

describe("deep-dive ranking (index-only novelty proxy)", () => {
  test("more entities + drift-group membership rank higher", () => {
    // value "$100k" recurs across A and B → drift members; C has no drift but
    // many entities; D is low on both.
    const A = rec({ path: "/a", entities: ["X", "Y"], quantities: [{ kind: "money", value: "$100k", context: "c" }] });
    const B = rec({ path: "/b", entities: ["Z"], quantities: [{ kind: "money", value: "$100k", context: "c" }] });
    const C = rec({ path: "/c", entities: ["P", "Q", "R", "S"], quantities: [] });
    const D = rec({ path: "/d", entities: [], quantities: [] });
    const ranked = rankDeepDiveCandidates([D, A, B, C]);
    // C (4 entities, 0 drift = 4) and A (2 entities + 1 drift = 3) top; D last.
    expect(ranked[0]!.path).toBe("/c");
    expect(ranked[ranked.length - 1]!.path).toBe("/d");
  });

  test("orderedDeepDivePaths preserves the ranked input order (novelty → cursor)", () => {
    // orderedDeepDivePaths now returns the ALREADY-RANKED order verbatim (the
    // cursor walks novelty order), so pass it the output of rankDeepDiveCandidates.
    const r1 = rec({ path: "/z", date: "2026-05-01" });
    const r2 = rec({ path: "/a", date: "2026-05-10" });
    const r3 = rec({ path: "/m", date: "2026-05-10" });
    const ranked = rankDeepDiveCandidates([r1, r2, r3]);
    expect(orderedDeepDivePaths(ranked)).toEqual(ranked.map((r) => r.path));
    // With equal novelty (all zero), the rank's date-desc-then-path tiebreak holds.
    expect(orderedDeepDivePaths(ranked)).toEqual(["/a", "/m", "/z"]);
  });

  test("novelty rank drives cursor order: high-novelty old thread beats older-but-plain", () => {
    // OLDER but high-novelty (many entities + drift) must come BEFORE a newer
    // low-novelty thread — proving novelty, not date, is the primary key.
    const novelOld = rec({
      path: "/novel-old",
      date: "2026-01-01",
      entities: ["A", "B", "C", "D", "E"],
      quantities: [{ kind: "money", value: "$1m", context: "c" }],
    });
    const drifty = rec({
      path: "/drifty",
      date: "2026-02-01",
      entities: ["F"],
      quantities: [{ kind: "money", value: "$1m", context: "c" }], // drift w/ novelOld
    });
    const plainNew = rec({ path: "/plain-new", date: "2026-05-01", entities: [], quantities: [] });
    const ranked = rankDeepDiveCandidates([plainNew, drifty, novelOld]);
    const order = orderedDeepDivePaths(ranked);
    // novelOld (5 entities + 1 drift = 6) first; plainNew (0) last — date ignored.
    expect(order[0]).toBe("/novel-old");
    expect(order[order.length - 1]).toBe("/plain-new");
    expect(order.indexOf("/novel-old")).toBeLessThan(order.indexOf("/plain-new"));
  });
});

describe("renderBrief", () => {
  const base = {
    runId: "2026-06-11T14:00:00Z",
    mode: "daily" as const,
    since: "2026-06-04",
    cap: 3,
    recency: [match({ path: "/abs/r1.md", title: "Recent A", date: "2026-06-08" })],
    deepDive: match({ path: "/abs/d1.md", title: "Old Thread", date: "2026-04-02" }),
    deepDiveWrapped: false,
    preferences: "- [learned] keep it short",
    distillDegraded: false,
    baselineSummary: "2 prior artifact(s)",
  };

  test("a valid brief carries cap, since, the recency + deep-dive picks, prefs", () => {
    const md = renderBrief(base);
    expect(md).toContain("# Feed-run brief — 2026-06-11T14:00:00Z");
    expect(md).toContain("MAX_ARTIFACTS_PER_RUN (cap): **3**");
    expect(md).toContain("recency since: 2026-06-04");
    expect(md).toContain("/abs/r1.md");
    expect(md).toContain("/abs/d1.md");
    expect(md).toContain("Old Thread");
    expect(md).toContain("keep it short");
    expect(md).toContain("Prior-artifact baseline");
  });

  test("cap reflected for backfill", () => {
    expect(renderBrief({ ...base, mode: "backfill", cap: 25 })).toContain("cap): **25**");
  });

  test("empty recency → deep-dive-only note; no deep-dive → recency-only note", () => {
    const a = renderBrief({ ...base, recency: [] });
    expect(a).toContain("deep-dive-only run");
    const b = renderBrief({ ...base, deepDive: undefined });
    expect(b).toContain("recency-only run");
  });

  test("degraded distill is flagged in the panel header", () => {
    expect(renderBrief({ ...base, distillDegraded: true })).toContain("distill degraded");
  });

  test("wrapped cursor is annotated", () => {
    expect(renderBrief({ ...base, deepDiveWrapped: true })).toContain("cursor wrapped");
  });
});

describe("run-log summary + topic keys", () => {
  test("summarizeRun is a single inspectable line", () => {
    const log: RunLog = {
      run_id: "2026-06-11T14:00:00Z",
      mode: "daily",
      dry_run: true,
      since: "2026-06-04",
      cap: 3,
      steps: [],
      recency_paths: ["/a", "/b"],
      deepdive_path: "/c",
      deepdive_wrapped: true,
      artifacts_published: [],
      outcome: "completed",
      finished_at: "2026-06-11T14:00:01Z",
    };
    const line = summarizeRun(log);
    expect(line).toContain("mode=daily dry-run");
    expect(line).toContain("recency=2");
    expect(line).toContain("deepdive=1(wrapped)");
    expect(line).toContain("published=0");
    expect(line).toContain("outcome=completed");
  });

  test("topicKeysFor joins top entities/terms, lowercased", () => {
    const r = rec({ path: "/x", entities: ["OpenKey", "Flashbots"], terms: ["permissioning"] });
    expect(topicKeysFor(r, 3)).toEqual(["openkey,flashbots,permissioning"]);
    expect(topicKeysFor(rec({ path: "/y" }))).toEqual([]);
  });
});

describe("pipeline step order constant", () => {
  test("steps are index → distill → query → brief → generate → save", () => {
    expect(PIPELINE_STEPS).toEqual([
      "index",
      "distill",
      "query-recency",
      "query-deepdive",
      "brief",
      "generate",
      "save",
    ]);
  });
});

// ===========================================================================
// 2. end-to-end CLI integration
// ===========================================================================

interface RunCtx {
  dir: string;
  transcriptsDir: string;
  indexPath: string;
  ledgerPath: string;
  runsDir: string;
  runLogPath: string;
  prefsPath: string;
}

async function writeTranscript(dir: string, name: string, date: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(
    p,
    `# ${name.replace(/\.md$/, "")}\n**Date:** ${date}\n\n**Ada:** ${body}\n\n**Grace:** Agreed, ${body}\n`,
  );
  return p;
}

function runCli(ctx: RunCtx, extraArgs: string[], env: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(
    "bun",
    [
      "skills/feed-run/scripts/feed-run.ts",
      "--index-path",
      ctx.indexPath,
      "--ledger",
      ctx.ledgerPath,
      "--runs-dir",
      ctx.runsDir,
      "--run-log",
      ctx.runLogPath,
      "--preferences",
      ctx.prefsPath,
      "--artifacts-dir",
      join(ctx.dir, "artifacts"),
      ...extraArgs,
    ],
    {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, TRANSCRIPT_DIRS: ctx.transcriptsDir, ...env },
    },
  );
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

async function readRunLog(ctx: RunCtx): Promise<RunLog[]> {
  const raw = await readFile(ctx.runLogPath, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunLog);
}

async function readLedgerFile(
  ctx: RunCtx,
): Promise<{ deepdive_cursor: { last_path?: string }; surfaced: unknown[] } | null> {
  try {
    return JSON.parse(await readFile(ctx.ledgerPath, "utf8"));
  } catch {
    return null;
  }
}

describe("feed-run CLI (e2e, synthetic corpus)", () => {
  let ctx: RunCtx;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "feed-run-"));
    const transcriptsDir = join(dir, "Fireflies-Transcripts");
    await mkdir(transcriptsDir, { recursive: true });
    ctx = {
      dir,
      transcriptsDir,
      indexPath: join(dir, "corpus-index.json"),
      ledgerPath: join(dir, "surfaced.json"),
      runsDir: join(dir, "runs"),
      runLogPath: join(dir, "run-log.jsonl"),
      prefsPath: join(dir, "PREFERENCES.md"),
    };
    await writeFile(ctx.prefsPath, "- [learned] synthetic preference panel\n");
    // Two recent + two older transcripts (older = deep-dive candidates).
    await writeTranscript(transcriptsDir, "recent-a.md", "2026-06-09", "we shipped OpenKey delegation");
    await writeTranscript(transcriptsDir, "recent-b.md", "2026-06-08", "permissioning needs a guardrail");
    await writeTranscript(transcriptsDir, "old-a.md", "2026-04-02", "early OpenKey idea worth ten dollars");
    await writeTranscript(transcriptsDir, "old-b.md", "2026-03-15", "another older thread about transcripts");
  });

  afterEach(async () => {
    await rm(ctx.dir, { recursive: true, force: true });
  });

  test("--dry-run produces a valid brief + ordered run-log; stops before generation", async () => {
    const { status, stdout } = runCli(ctx, ["--dry-run", "--since", "2026-06-07"]);
    expect(status).toBe(0);
    // The brief is on stdout.
    expect(stdout).toContain("# Feed-run brief");
    expect(stdout).toContain("MAX_ARTIFACTS_PER_RUN (cap): **3**");
    expect(stdout).toContain("recent-a.md");

    const logs = await readRunLog(ctx);
    expect(logs.length).toBe(1);
    const log = logs[0]!;
    expect(log.outcome).toBe("completed");
    expect(log.dry_run).toBe(true);
    // Step ordering: index → distill → query-recency → query-deepdive → brief → generate → save.
    const order = log.steps.map((s) => s.step);
    expect(order).toEqual([
      "index",
      "distill",
      "query-recency",
      "query-deepdive",
      "brief",
      "generate",
      "save",
    ]);
    // index ok, generation skipped on dry-run.
    expect(log.steps.find((s) => s.step === "index")!.status).toBe("ok");
    expect(log.steps.find((s) => s.step === "generate")!.status).toBe("skipped");
    // recency picked the two recent transcripts; one deep-dive selected.
    expect(log.recency_paths.length).toBe(2);
    expect(log.deepdive_path).toBeDefined();

    // A run-brief.md + run-log.json landed in the per-run dir.
    const brief = await readFile(
      join(ctx.runsDir, log.run_id.replace(/[:]/g, "-"), "run-brief.md"),
      "utf8",
    );
    expect(brief).toContain("# Feed-run brief");
  });

  test("distill failure degrades — run continues with existing PREFERENCES.md", async () => {
    // Point the distill step at a stub script that exits non-zero.
    const failStub = join(ctx.dir, "fail-distill.ts");
    await writeFile(failStub, "process.exit(7);\n");
    const { status } = runCli(ctx, ["--dry-run", "--since", "2026-06-07"], {
      FEED_RUN_DISTILL_CMD: failStub,
    });
    expect(status).toBe(0); // the run does NOT hard-fail on distill

    const log = (await readRunLog(ctx))[0]!;
    expect(log.outcome).toBe("completed");
    const distill = log.steps.find((s) => s.step === "distill")!;
    expect(distill.status).toBe("degraded");
    // The brief still carries the existing (last-known-good) preferences panel.
    const brief = await readFile(
      join(ctx.runsDir, log.run_id.replace(/[:]/g, "-"), "run-brief.md"),
      "utf8",
    );
    expect(brief).toContain("synthetic preference panel");
    expect(brief).toContain("distill degraded");
  });

  test("cap is reflected in the brief — backfill bumps it to 25", async () => {
    const { stdout } = runCli(ctx, ["--dry-run", "--mode", "backfill", "--since", "2026-06-07"]);
    expect(stdout).toContain("mode: **backfill**");
    expect(stdout).toContain("cap): **25**");
  });

  test("deep-dive cursor advances across two runs", async () => {
    // Run 1: picks the first older thread, records the cursor in the ledger.
    runCli(ctx, ["--dry-run", "--since", "2026-06-07"]);
    let logs = await readRunLog(ctx);
    const firstPick = logs[0]!.deepdive_path;
    expect(firstPick).toBeDefined();

    // The orchestrator advanced the cursor to firstPick. To prove advance, we
    // mark the first pick as already-surfaced (a prior run shipped it) so it
    // drops from the unsurfaced candidate set, then run again: the cursor must
    // move to a DIFFERENT older thread.
    const ledger = {
      version: 1,
      deepdive_cursor: { last_path: firstPick },
      surfaced: [
        {
          path: firstPick,
          topic_keys: ["x"],
          run_id: "2026-06-10T00:00:00Z",
          outcome: "shipped",
          mode: "deepdive",
        },
      ],
    };
    await writeFile(ctx.ledgerPath, JSON.stringify(ledger, null, 2));

    runCli(ctx, ["--dry-run", "--since", "2026-06-07"]);
    logs = await readRunLog(ctx);
    const secondPick = logs[logs.length - 1]!.deepdive_path;
    expect(secondPick).toBeDefined();
    expect(secondPick).not.toBe(firstPick); // cursor advanced to a new thread
  });

  // ---- PR#5 review regressions ----

  test("real (non-dry) run persists the advanced deep-dive cursor (orchestrator-owned)", async () => {
    // No --dry-run: the orchestrator must persist the cursor ITSELF, so a later
    // run resumes after it even though the agent (which would append surfaced
    // entries) never ran here.
    const { status } = runCli(ctx, ["--since", "2026-06-07"]);
    expect(status).toBe(0);
    const log = (await readRunLog(ctx))[0]!;
    const picked = log.deepdive_path;
    expect(picked).toBeDefined();
    // The ledger file now exists with the cursor moved onto the picked thread.
    const ledger = await readLedgerFile(ctx);
    expect(ledger).not.toBeNull();
    expect(ledger!.deepdive_cursor.last_path).toBe(picked);
    // The orchestrator persisted ONLY the cursor — no surfaced entries (those
    // are the agent's job after generation).
    expect(ledger!.surfaced).toEqual([]);
    // The "save" step reports the persisted advance.
    const save = log.steps.find((s) => s.step === "save")!;
    expect(save.status).toBe("ok");
    expect(save.detail).toContain("cursor advanced");
    expect(save.detail).toContain("persisted");
  });

  test("zero-deep-dive-artifact run still advances the cursor (no re-pick forever)", async () => {
    // A real run that ships NOTHING (the orchestrator never generates) must
    // still move the cursor off the picked thread, so the next real run picks a
    // DIFFERENT older thread instead of re-picking the same one forever.
    const r1 = runCli(ctx, ["--since", "2026-06-07"]);
    expect(r1.status).toBe(0);
    const firstPick = (await readRunLog(ctx))[0]!.deepdive_path;
    expect(firstPick).toBeDefined();
    const ledger1 = await readLedgerFile(ctx);
    expect(ledger1!.deepdive_cursor.last_path).toBe(firstPick);
    expect(ledger1!.surfaced).toEqual([]); // nothing shipped

    // Second real run reuses the persisted cursor and advances PAST firstPick.
    const r2 = runCli(ctx, ["--since", "2026-06-07"]);
    expect(r2.status).toBe(0);
    const logs = await readRunLog(ctx);
    const secondPick = logs[logs.length - 1]!.deepdive_path;
    expect(secondPick).toBeDefined();
    expect(secondPick).not.toBe(firstPick); // advanced despite zero artifacts
  });

  test("--dry-run does NOT persist the cursor but REPORTS the would-be advance", async () => {
    const { status, stdout } = runCli(ctx, ["--dry-run", "--since", "2026-06-07"]);
    expect(status).toBe(0);
    const log = (await readRunLog(ctx))[0]!;
    expect(log.deepdive_path).toBeDefined();
    // No ledger file was written (dry-run must not mutate state).
    expect(await readLedgerFile(ctx)).toBeNull();
    // But the save step REPORTS the would-be advance.
    const save = log.steps.find((s) => s.step === "save")!;
    expect(save.status).toBe("skipped");
    expect(save.detail).toContain("WOULD advance deep-dive cursor");
    expect(save.detail).toContain("not persisted");
    // The brief is still produced.
    expect(stdout).toContain("# Feed-run brief");
  });

  test("--skip-index --dry-run with unset TRANSCRIPT_DIRS still produces a brief", async () => {
    // First build an index normally (this run has TRANSCRIPT_DIRS).
    const built = runCli(ctx, ["--dry-run", "--since", "2026-06-07"]);
    expect(built.status).toBe(0);

    // Now run with --skip-index and TRANSCRIPT_DIRS UNSET: previously the index
    // step hard-required the env var and aborted before the brief. With
    // --skip-index it reuses the existing index and still produces a brief.
    const res = spawnSync(
      "bun",
      [
        "skills/feed-run/scripts/feed-run.ts",
        "--index-path",
        ctx.indexPath,
        "--ledger",
        ctx.ledgerPath,
        "--runs-dir",
        ctx.runsDir,
        "--run-log",
        ctx.runLogPath,
        "--preferences",
        ctx.prefsPath,
        "--artifacts-dir",
        join(ctx.dir, "artifacts"),
        "--skip-index",
        "--dry-run",
        "--since",
        "2026-06-07",
      ],
      {
        cwd: REPO,
        encoding: "utf8",
        // Deliberately scrub TRANSCRIPT_DIRS from the environment.
        env: (() => {
          const e = { ...process.env };
          delete e.TRANSCRIPT_DIRS;
          return e;
        })(),
      },
    );
    expect(res.status).toBe(0);
    expect(res.stdout ?? "").toContain("# Feed-run brief");
    const logs = await readRunLog(ctx);
    const last = logs[logs.length - 1]!;
    expect(last.outcome).toBe("completed");
    // The index step was skipped (reused), not run.
    expect(last.steps.find((s) => s.step === "index")!.status).toBe("skipped");
  });
});
