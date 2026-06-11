#!/usr/bin/env bun
// feed-run.ts — the runnable feed-run recipe orchestrator (spec §5).
//
// This is Layer 2 made runnable: a bun orchestrator that shells the Layer-1
// skill scripts in order (index-corpus → distill-preferences → query-corpus
// recency + deep-dive), then PREPARES a run-brief that a generation agent/SKILL
// consumes. It is itself invokable by the future launchd cron (spec §7) and the
// Generate button (spec §8).
//
// JUDGMENT-VS-PLUMBING (base SPEC, NON-NEGOTIABLE): this orchestrator makes NO
// model calls. It runs deterministic scripts and assembles a markdown brief.
// GENERATION (extract-insights / write-article / make-podcast + illustrate-card)
// is AGENT judgment that happens AFTER the brief — the orchestrator documents
// that handoff and `--dry-run` stops here, having produced the brief. The
// generate/critic/publish steps are agent-driven per the existing generation
// skills; see skills/feed-run/SKILL.md for the agent's runbook.
//
// Usage:
//   bun skills/feed-run/scripts/feed-run.ts \
//     [--mode daily|backfill]      # daily heartbeat (default) | one-time excavation (stub) \
//     [--since 14d|2026-06-01]     # recency lower bound (relative or absolute); \
//                                  #   default = last run from ledger, else 7 days \
//     [--dry-run]                  # stop after producing the brief (no generation) \
//     [--skip-index]               # reuse the existing index (don't re-index); \
//                                  #   lets --dry-run / the Generate button run \
//                                  #   without $TRANSCRIPT_DIRS set \
//     [--index-path index/corpus-index.json] \
//     [--ledger index/surfaced.json] \
//     [--artifacts-dir artifacts] \
//     [--preferences PREFERENCES.md] \
//     [--runs-dir index/runs] [--run-log index/run-log.jsonl] \
//     [--recency-limit N]          # cap recency matches surfaced into the brief
//
// Per-step failure degradation (spec §5): INDEX failure ABORTS (everything
// downstream needs a fresh index); DISTILL failure proceeds with the existing
// PREFERENCES.md (logged); empty recency → deep-dive-only; no eligible deep-dive
// → recency-only. All step outcomes append to a structured run log.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readIndex } from "../../index-corpus/scripts/corpus-index.ts";
import {
  queryCorpus,
  type QueryMatch,
  type QueryResult,
} from "../../query-corpus/scripts/corpus-query.ts";
import {
  readLedger,
  writeLedger,
  advanceCursor,
  type SurfacedLedger,
} from "../../query-corpus/scripts/surfaced-ledger.ts";
import { priorArtifactIndex } from "../../_shared/lib/novelty.ts";
import {
  capForMode,
  olderThan,
  orderedDeepDivePaths,
  parseRelativeSince,
  rankDeepDiveCandidates,
  renderBrief,
  resolveSince,
  summarizeRun,
  type RunLog,
  type RunMode,
  type StepLog,
  type StepStatus,
} from "./feed-run-lib.ts";

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(
    "usage: bun skills/feed-run/scripts/feed-run.ts " +
      "[--mode daily|backfill] [--since 14d|YYYY-MM-DD] [--dry-run] [--skip-index] " +
      "[--index-path PATH] [--ledger PATH] [--artifacts-dir DIR] " +
      "[--preferences PATH] [--runs-dir DIR] [--run-log PATH] [--recency-limit N]",
  );
  process.exit(2);
}

let mode: RunMode = "daily";
let sinceArg: string | undefined;
let dryRun = false;
let skipIndex = false;
let indexPath = "index/corpus-index.json";
let ledgerPath = "index/surfaced.json";
let artifactsDir = "artifacts";
let preferencesPath = "PREFERENCES.md";
let runsDir = "index/runs";
let runLogPath = "index/run-log.jsonl";
let recencyLimit: number | undefined;

const args = process.argv.slice(2);
function takeValue(i: number): string {
  const v = args[i];
  if (v === undefined) usage();
  return v;
}
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  switch (arg) {
    case "--mode": {
      const v = takeValue(++i);
      if (v !== "daily" && v !== "backfill") usage();
      mode = v;
      break;
    }
    case "--since":
      sinceArg = takeValue(++i);
      break;
    case "--dry-run":
      dryRun = true;
      break;
    case "--skip-index":
      skipIndex = true;
      break;
    case "--index-path":
      indexPath = takeValue(++i);
      break;
    case "--ledger":
      ledgerPath = takeValue(++i);
      break;
    case "--artifacts-dir":
      artifactsDir = takeValue(++i);
      break;
    case "--preferences":
      preferencesPath = takeValue(++i);
      break;
    case "--runs-dir":
      runsDir = takeValue(++i);
      break;
    case "--run-log":
      runLogPath = takeValue(++i);
      break;
    case "--recency-limit": {
      const n = Number(takeValue(++i));
      if (!Number.isInteger(n) || n < 0) {
        console.error("--recency-limit must be a non-negative integer");
        process.exit(2);
      }
      recencyLimit = n;
      break;
    }
    case "--help":
    case "-h":
      usage();
    default:
      usage();
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const now = new Date();
const runId = now.toISOString();
const cap = capForMode(mode);
if (mode === "backfill") {
  // TODO(PR6): full backfill = no recency window, novelty-ranked batches with a
  // resumable checkpoint, MAX_ARTIFACTS_BACKFILL budget. This PR wires the flag
  // + the larger cap only; the daily deep-dive path runs underneath for now.
  console.error(
    `[feed-run] --mode backfill: STUB (cap ${cap}). Full batched/checkpointed ` +
      `excavation is deferred to PR6; running the daily selection path with the ` +
      `larger cap surfaced in the brief.`,
  );
}

const steps: StepLog[] = [];
const log = (step: StepLog["step"], status: StepStatus, detail: string): void => {
  steps.push({ step, status, detail });
  console.error(`[feed-run] ${step}: ${status}${detail ? ` — ${detail}` : ""}`);
};

/** Shell a deterministic skill script. Returns ok + captured stderr (counts). */
function runScript(argv: string[]): { ok: boolean; stderr: string } {
  const res = spawnSync("bun", argv, { encoding: "utf8" });
  const stderr = (res.stderr ?? "").trim();
  return { ok: res.status === 0, stderr };
}

async function finish(
  outcome: RunLog["outcome"],
  extras: Partial<RunLog>,
  brief?: string,
): Promise<RunLog> {
  const full: RunLog = {
    run_id: runId,
    mode,
    dry_run: dryRun,
    since: extras.since ?? "",
    cap,
    steps,
    recency_paths: extras.recency_paths ?? [],
    deepdive_path: extras.deepdive_path,
    deepdive_wrapped: extras.deepdive_wrapped ?? false,
    artifacts_published: extras.artifacts_published ?? [],
    outcome,
    finished_at: new Date().toISOString(),
  };
  // Write the structured run log (per-run dir) + append the one-liner (§7).
  const runDir = join(runsDir, runId.replace(/[:]/g, "-"));
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "run-log.json"), JSON.stringify(full, null, 2) + "\n");
  if (brief !== undefined) {
    await writeFile(join(runDir, "run-brief.md"), brief);
  }
  await appendJsonl(runLogPath, full);
  console.error(`[feed-run] ${summarizeRun(full)}`);
  console.error(`[feed-run] run dir: ${runDir}`);
  return full;
}

async function appendJsonl(path: string, obj: unknown): Promise<void> {
  let prior = "";
  try {
    prior = await readFile(path, "utf8");
  } catch {
    // first line
  }
  await writeFile(path, prior + JSON.stringify(obj) + "\n");
}

// 1. INDEX — failure ABORTS (everything downstream depends on a fresh index).
//    --skip-index reuses the already-built index (no re-index, no
//    $TRANSCRIPT_DIRS required) — for dry-run / the Generate button against an
//    existing index. The index must already exist; a missing one aborts.
if (skipIndex) {
  if ((await readIndex(indexPath)) === undefined) {
    log("index", "aborted", `--skip-index but no existing index at ${indexPath}`);
    await finish("aborted", {});
    console.error("[feed-run] ABORTED: --skip-index requires an existing index; feed unchanged.");
    process.exit(1);
  }
  log("index", "skipped", `--skip-index: reusing existing index at ${indexPath}`);
} else {
  const argv = ["skills/index-corpus/scripts/index-corpus.ts", "--prune", "--index-path", indexPath];
  const { ok, stderr } = runScript(argv);
  if (!ok) {
    log("index", "aborted", `index-corpus failed; ${lastLine(stderr)}`);
    await finish("aborted", {});
    console.error("[feed-run] ABORTED: fresh index unavailable; feed unchanged.");
    process.exit(1);
  }
  log("index", "ok", countsLine(stderr));
}

// Load the freshly-built index (graceful empty if somehow missing).
const index = (await readIndex(indexPath)) ?? {
  version: 1,
  generated_at: runId,
  transcript_dirs: [],
  transcripts: [],
  warnings: [],
};

// Ledger + last-run resolution (drives --since default + the deep-dive cursor).
let ledger: SurfacedLedger = await readLedger(ledgerPath);
const lastRunIso = ledger.surfaced.reduce<string | undefined>(
  (acc, e) => (acc === undefined || e.run_id > acc ? e.run_id : acc),
  undefined,
);

// Resolve the recency lower bound: relative window (14d) → absolute date →
// ledger last run → 7 days (spec §5 RECENCY_SINCE).
let since: string;
if (sinceArg) {
  since = parseRelativeSince(sinceArg, now) ?? resolveSince(sinceArg, lastRunIso, now);
} else {
  since = resolveSince(undefined, lastRunIso, now);
}

// 2. DISTILL — runs BEFORE generation ([D4]); failure degrades to existing
//    PREFERENCES.md (last-known-good), logged, not fatal. The distill script
//    path is overridable via $FEED_RUN_DISTILL_CMD purely as a test seam (a
//    deliberately-failing stub exercises the degradation branch); production
//    always uses the real summarize-events.ts default.
let distillDegraded = false;
{
  const distillScript =
    process.env.FEED_RUN_DISTILL_CMD ??
    "skills/distill-preferences/scripts/summarize-events.ts";
  const { ok, stderr } = runScript([
    distillScript,
    "--format",
    "md",
    "--artifacts-dir",
    artifactsDir,
  ]);
  if (!ok) {
    distillDegraded = true;
    log("distill", "degraded", `summarize-events failed; using existing ${preferencesPath}. ${lastLine(stderr)}`);
  } else {
    // The aggregation succeeded; the PREFERENCES.md UPDATE itself is agent
    // judgment (distill-preferences SKILL.md) and is not performed here. We
    // simply carry the current PREFERENCES.md into the brief as last-known-good.
    log("distill", "ok", "feedback aggregated; PREFERENCES.md update is agent judgment (brief carries current panel)");
  }
}
let preferences = "(no PREFERENCES.md found)";
try {
  preferences = await readFile(preferencesPath, "utf8");
} catch {
  log("distill", "degraded", `${preferencesPath} not found; brief notes the gap`);
}

// Baseline (for the surfaced join + the brief summary).
const baseline = await priorArtifactIndex(artifactsDir);
const baselineSummary =
  `${baseline.entries.length} prior artifact(s) in ${artifactsDir} form the surfaced baseline` +
  (baseline.warnings.length ? ` (${baseline.warnings.length} warning(s))` : "");

// 3a. QUERY — recency window, unsurfaced-only. Empty window → deep-dive only.
const recencyResult: QueryResult = queryCorpus(index, baseline, ledger, {
  since,
  unsurfacedOnly: true,
  limit: recencyLimit,
});
const recency: QueryMatch[] = recencyResult.matches;
log(
  "query-recency",
  recency.length > 0 ? "ok" : "skipped",
  recency.length > 0
    ? `${recency.length} new transcript(s) since ${since}`
    : `recency window empty since ${since} — deep-dive-only run`,
);

// 3b. QUERY — deep-dive: ONE high-novelty, never-surfaced older thread past the
//     cursor; advance the cursor. No eligible candidate → recency-only run.
const olderPool = olderThan(index, since);
const olderResult = queryCorpus(index, baseline, ledger, {
  until: priorDay(since),
  unsurfacedOnly: true,
});
const eligiblePaths = new Set(olderResult.matches.map((m) => m.path));
const rankedEligible = rankDeepDiveCandidates(
  olderPool.filter((r) => eligiblePaths.has(r.path)),
);
const orderedCandidates = orderedDeepDivePaths(rankedEligible);
const advance = advanceCursor(ledger, orderedCandidates);
let deepDive: QueryMatch | undefined;
if (advance.next) {
  deepDive = olderResult.matches.find((m) => m.path === advance.next);
  ledger = advance.ledger; // cursor moved to the picked path
  log(
    "query-deepdive",
    "ok",
    `picked 1 older thread${advance.wrapped ? " (cursor wrapped)" : ""} of ${orderedCandidates.length} eligible`,
  );
} else {
  log("query-deepdive", "skipped", "no eligible older thread (all surfaced) — recency-only run");
}

// 4. BRIEF — the deterministic handoff artifact (titles/paths only, no content).
const brief = renderBrief({
  runId,
  mode,
  since,
  cap,
  recency,
  deepDive,
  deepDiveWrapped: advance.wrapped,
  preferences,
  distillDegraded,
  baselineSummary,
});
log("brief", "ok", `brief prepared (${recency.length} recency + ${deepDive ? 1 : 0} deep-dive, cap ${cap})`);

// 5/6. GENERATE + SAVE — AGENT judgment. The orchestrator stops here on
//      --dry-run (the safe default), having produced the brief. A non-dry run
//      hands the brief to the generation skills (see SKILL.md); this script
//      does NOT call an LLM, so it logs the handoff and stops too — the agent
//      driving the recipe performs generation, then APPENDS the surfaced
//      ENTRIES (per SKILL.md). We never auto-spend here.
//
//      CURSOR PERSISTENCE (PR#5 review): the orchestrator holds the
//      authoritative advanced cursor (`advance.ledger`) and persists it ITSELF
//      — NOT delegated to the agent. This guarantees the deep-dive cursor moves
//      off the picked thread even on a zero-artifact run (the agent ships
//      nothing → no surfaced entry → without this the same thread is re-picked
//      forever). The agent later appends only surfaced ENTRIES; it must NOT
//      reconstruct the cursor. EXCEPTION: --dry-run never mutates state, so it
//      REPORTS the would-be advance but does not write.
if (dryRun) {
  log("generate", "skipped", "--dry-run: stopped after brief (no generation)");
  log(
    "save",
    "skipped",
    advance.next
      ? `--dry-run: nothing published; WOULD advance deep-dive cursor to ${advance.next}${advance.wrapped ? " (wrapped)" : ""} (not persisted)`
      : "--dry-run: nothing published",
  );
} else {
  log(
    "generate",
    "skipped",
    "generation is agent judgment — run the generation skills against the brief (SKILL.md); orchestrator never calls an LLM",
  );
  if (advance.next) {
    // Persist the advanced cursor authoritatively (cursor only; the agent
    // appends surfaced entries onto whatever ledger exists at write time).
    await writeLedger(ledgerPath, ledger);
    log(
      "save",
      "ok",
      `deep-dive cursor advanced to ${advance.next}${advance.wrapped ? " (wrapped)" : ""} and persisted; publish + surfaced-entry append happen after agent generation (SKILL.md)`,
    );
  } else {
    log("save", "skipped", "no deep-dive this run (cursor unchanged); publish + surfaced-entry append happen after agent generation (SKILL.md)");
  }
}

const finalLog = await finish(
  "completed",
  {
    since,
    recency_paths: recency.map((m) => m.path),
    deepdive_path: deepDive?.path,
    deepdive_wrapped: advance.wrapped,
  },
  brief,
);

// Print the brief to stdout (so the agent / a pipe consumes it directly).
console.log(brief);
void finalLog;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The day before a YYYY-MM-DD (the deep-dive pool is strictly older than `since`). */
function priorDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function lastLine(s: string): string {
  const lines = s.split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1]!.slice(0, 200) : "";
}
function countsLine(s: string): string {
  // index-corpus prints a multi-line counts block to stderr; keep the first.
  return s.split("\n").filter(Boolean)[0]?.slice(0, 200) ?? "";
}
