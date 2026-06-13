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
// skills; see harness/feed-run/SKILL.md for the agent's runbook.
//
// Usage:
//   bun harness/feed-run/scripts/feed-run.ts \
//     [--mode daily|backfill]      # daily heartbeat (default) | one-time excavation (stub) \
//     [--since 14d|2026-06-01]     # recency lower bound (relative or absolute); \
//                                  #   default = last run from ledger, else 7 days \
//     [--dry-run]                  # stop after producing the brief (no generation) \
//     [--no-generate]              # produce the brief but skip headless generation \
//                                  #   (the Generate button's dry preview) \
//     [--model opus]               # generation model (else $MEET_GEN_MODEL, else opus) \
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

import { mkdir, readdir, readFile, writeFile, rename } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
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
import { priorArtifactIndex } from "../../../skills/_shared/lib/novelty.ts";
import { runGeneration } from "./run-generation.ts";
import { resolveModel, summarizeGeneration } from "./run-generation-lib.ts";
import {
  capForMode,
  olderThan,
  orderedDeepDivePaths,
  parseRelativeSince,
  rankDeepDiveCandidates,
  rankRecencyByPreference,
  explorationPick,
  INTERNAL_FEED_FORMATS,
  renderBrief,
  resolveSince,
  type InternalFeedFormat,
  summarizeRun,
  type PipelineStep,
  type RunLog,
  type RunMode,
  type StepLog,
  type StepStatus,
} from "./feed-run-lib.ts";
import {
  parsePreferenceSignal,
  hasSignal,
} from "../../query-corpus/scripts/preference-signal.ts";
import {
  findSalientPeople,
  summarizeSalient,
  DEFAULT_SALIENCE_MIN_TRANSCRIPTS,
  type SalientPerson,
} from "./salient-people-lib.ts";

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(
    "usage: bun harness/feed-run/scripts/feed-run.ts " +
      "[--mode daily|backfill] [--since 14d|YYYY-MM-DD] [--dry-run] [--no-generate] " +
      "[--model M] [--skip-index] " +
      "[--index-path PATH] [--ledger PATH] [--artifacts-dir DIR] " +
      "[--preferences PATH] [--runs-dir DIR] [--run-log PATH] [--recency-limit N] [--run-id ID] " +
      "[--explore-every N]",
  );
  process.exit(2);
}

let mode: RunMode = "daily";
let sinceArg: string | undefined;
let dryRun = false;
let noGenerate = false;
let modelArg: string | undefined;
let skipIndex = false;
let indexPath = "index/corpus-index.json";
let ledgerPath = "index/surfaced.json";
let artifactsDir = "artifacts";
let preferencesPath = "PREFERENCES.md";
let runsDir = "index/runs";
let runLogPath = "index/run-log.jsonl";
let recencyLimit: number | undefined;
let runIdArg: string | undefined;
// Format-exploration cadence: every Nth run the brief reserves one cap slot for
// the least-recently-produced internal format (anti-monoculture). 0 disables.
let exploreEvery = 3;

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
    case "--no-generate":
      noGenerate = true;
      break;
    case "--model":
      modelArg = takeValue(++i);
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
    case "--explore-every": {
      const n = Number(takeValue(++i));
      if (!Number.isInteger(n) || n < 0) {
        console.error("--explore-every must be a non-negative integer (0 disables)");
        process.exit(2);
      }
      exploreEvery = n;
      break;
    }
    case "--run-id":
      // Caller-supplied run id (the Generate button picks it so its status
      // endpoint can find index/runs/<run-id>/ before the run finishes). When
      // unset, defaults to the start timestamp below.
      runIdArg = takeValue(++i);
      break;
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
const runId = runIdArg ?? now.toISOString();
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

// The sanitized run-dir name (colons → dashes) — MUST match how generate.ts
// (runDirName) + the route name index/runs/<sanitized>/, so the status endpoint
// reads the same run-log this orchestrator writes incrementally.
const runDirName = runId.replace(/[:]/g, "-");
const progressRunDir = join(runsDir, runDirName);
const progressLogPath = join(progressRunDir, "run-log.json");

// INCREMENTAL RUN-LOG (PR #14 fix #1). The status endpoint reads run-log.json's
// steps[] to drive the live stage track. If we only wrote it in finish() (once,
// at the end) the bar would sit inert all run then snap to done. So we persist a
// PARTIAL run-log after EACH step completes — atomic (tmp + rename) and cheap —
// and keep the authoritative full write in finish(). The partial carries the
// in-flight steps[] (+ run_id/mode/dry_run/cap) with NO terminal `outcome`, so
// the endpoint reads it as still-running (isDone keys off outcome:"completed").
//
// The writes are SYNCHRONOUS on purpose: the pipeline's long steps run under
// spawnSync, which blocks the event loop — an async fire-and-forget write
// queued just before one would not flush until that step FINISHED, i.e. the
// partial would land exactly when it stops being useful. A sync write
// happens-before the blocking step and makes ordering trivial (no chain).
// Payload is a few KB; cost is sub-ms.
let runDirReady = false;
function writePartial(stepsSnapshot: ReadonlyArray<StepLog | ActiveStep>): void {
  try {
    if (!runDirReady) {
      mkdirSync(progressRunDir, { recursive: true });
      runDirReady = true;
    }
    const body =
      JSON.stringify(
        { run_id: runId, mode, dry_run: dryRun, cap, steps: stepsSnapshot },
        null,
        2,
      ) + "\n";
    const tmp = `${progressLogPath}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, progressLogPath);
  } catch {
    // Best-effort progress view — a write failure must NEVER fail the run. The
    // authoritative run-log is still written by finish().
  }
}

function persistProgress(): void {
  writePartial(steps.slice());
}

// Persist a partial run-log where `step` is marked `active` (in-flight) ON TOP of
// the committed steps[]. Used for the long GENERATE step: the agent works for
// minutes, so we flip generate→active the moment it starts (UI shows "Generating…"
// + artifact count fills within it) WITHOUT pushing a non-terminal status into the
// typed steps[] — the real terminal generate outcome is log()'d when runGeneration
// returns. The endpoint's buildStages reads `active` directly; the value never
// reaches the authoritative finish() run-log.
type ActiveStep = { step: PipelineStep; status: "active"; detail: string };
function markActive(step: PipelineStep, detail: string): void {
  console.error(`[feed-run] ${step}: active${detail ? ` — ${detail}` : ""}`);
  writePartial([...steps, { step, status: "active", detail }]);
}

const steps: StepLog[] = [];
const log = (step: StepLog["step"], status: StepStatus, detail: string): void => {
  steps.push({ step, status, detail });
  console.error(`[feed-run] ${step}: ${status}${detail ? ` — ${detail}` : ""}`);
  // Persist the partial run-log after each step so a poller sees stages advance
  // in real time (synchronous — see writePartial for why).
  persistProgress();
};

// t=0 WRITE: materialize the run dir + an (empty-steps) run-log within the first
// second of the run, BEFORE any pipeline step, so a poller never sees an empty
// "is it alive?" gap — the stage track renders index→…→save all-pending/active
// immediately, and a dead run is distinguishable from a healthy one faster.
persistProgress();

/** Shell a deterministic skill script. Returns ok + captured stdout/stderr. */
function runScript(argv: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("bun", argv, { encoding: "utf8" });
  const stdout = (res.stdout ?? "").trim();
  const stderr = (res.stderr ?? "").trim();
  return { ok: res.status === 0, stdout, stderr };
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
    drafts_produced: extras.drafts_produced,
    distill_skipped: extras.distill_skipped,
    distill_pending_events: extras.distill_pending_events,
    guard: extras.guard,
    outcome,
    finished_at: new Date().toISOString(),
  };
  // Write the AUTHORITATIVE structured run log (per-run dir) + append the
  // one-liner (§7). Drain any in-flight incremental progress writes FIRST and
  // chain this onto the same serial queue so a late partial can never
  // rename-clobber this final, terminal-outcome write.
  const runDir = progressRunDir;
  await mkdir(runDir, { recursive: true });
  const finalTmp = `${progressLogPath}.tmp`;
  await writeFile(finalTmp, JSON.stringify(full, null, 2) + "\n");
  await rename(finalTmp, progressLogPath);
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
  const argv = ["harness/index-corpus/scripts/index-corpus.ts", "--prune", "--index-path", indexPath];
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
//
//    THE LOOP-CLOSING WIRE (FIX A): the script does the DETERMINISTIC
//    aggregation; the generation agent does the JUDGMENT that turns it into
//    [learned] PREFERENCES.md lines. We CAPTURE the aggregation here and embed
//    it in the brief so the agent has the evidence in-context, and the brief +
//    both SKILL.md mandate distill-preferences as the agent's FIRST task
//    (update [learned] lines → re-read fresh PREFERENCES.md → THEN generate).
//    The orchestrator stays LLM-free; the agent owns the write.
let distillDegraded = false;
let feedbackSummary: string | undefined;
{
  const distillScript =
    process.env.FEED_RUN_DISTILL_CMD ??
    "harness/distill-preferences/scripts/summarize-events.ts";
  const { ok, stdout, stderr } = runScript([
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
    // The aggregation succeeded; CARRY ITS OUTPUT into the brief. The
    // PREFERENCES.md UPDATE itself is agent judgment (distill-preferences
    // SKILL.md) performed as the agent's FIRST task before generating.
    feedbackSummary = stdout || undefined;
    log("distill", "ok", "feedback aggregated → embedded in brief; agent applies distill-preferences as task #1 (updates [learned] lines, then re-reads + generates)");
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

// SALIENT-PEOPLE DETECTION (Phase 1b — person-brief on salience). DETERMINISTIC,
// model-free: surface recurring un-briefed speakers (>= N transcripts, minus
// those who already have a current person-brief). The detector decides WHO
// recurs; the generation agent JUDGES which (if any) earn a dossier. Runs over
// the freshly-built index + the artifacts dir; never throws on a missing dir.
let salientPeople: SalientPerson[] = [];
try {
  salientPeople = await findSalientPeople(index, artifactsDir, {
    minTranscripts: DEFAULT_SALIENCE_MIN_TRANSCRIPTS,
  });
  console.error(
    `[feed-run] salient-people: ${summarizeSalient(salientPeople, DEFAULT_SALIENCE_MIN_TRANSCRIPTS)}`,
  );
} catch (err) {
  // Surfacing failure is non-fatal — the run proceeds with no person-brief
  // candidates (the brief simply lists none). NEVER aborts the run.
  console.error(`[feed-run] salient-people: detection failed (${String(err).slice(0, 120)}) — none surfaced`);
}

// 3a. QUERY — recency window, unsurfaced-only. Empty window → deep-dive only.
const recencyResult: QueryResult = queryCorpus(index, baseline, ledger, {
  since,
  unsurfacedOnly: true,
  limit: recencyLimit,
});
let recency: QueryMatch[] = recencyResult.matches;
log(
  "query-recency",
  recency.length > 0 ? "ok" : "skipped",
  recency.length > 0
    ? `${recency.length} new transcript(s) since ${since}`
    : `recency window empty since ${since} — deep-dive-only run`,
);

// SELECTION BACKPRESSURE (spec phase 2A): re-rank the RECENCY pool by the
// [learned] preference signal so transcripts matching Hunter's loves rise and
// his dislikes sink. DETERMINISTIC + model-free (parsePreferenceSignal +
// scorePreferenceMatch are pure index-only keyword tallies). The deep-dive
// cursor below is DELIBERATELY left preference-agnostic — that's the
// exploration reserve (see feed-run-lib.ts rankRecencyByPreference doc). We log
// the weighting transparently: every candidate that moved carries its keyword
// hits. (Preferences read here are the PRE-distill panel; the agent's distill
// updates [learned] lines for the NEXT run's selection — selection backpressure
// is one run behind generation backpressure, by construction.)
// NB: this is TRANSPARENCY logging on the same `query-recency` step (stderr
// only) — it deliberately does NOT push another StepLog, so the pipeline step
// sequence stays singular (index → distill → query-recency → query-deepdive →
// …). The weighting reorders `recency` in place for the brief.
const prefSignal = parsePreferenceSignal(preferences);
if (recency.length > 0 && hasSignal(prefSignal)) {
  const recordByPath = new Map(index.transcripts.map((r) => [r.path, r]));
  const rankedRecency = rankRecencyByPreference(
    recency,
    prefSignal,
    (p) => recordByPath.get(p),
  );
  recency = rankedRecency.map((r) => r.match);
  const moved = rankedRecency.filter((r) => r.preferenceScore !== 0);
  console.error(
    `[feed-run] query-recency: preference-weighted — ${prefSignal.loved.size} loved + ` +
      `${prefSignal.disliked.size} disliked keyword(s); ` +
      `${moved.length}/${rankedRecency.length} candidate(s) moved by preference`,
  );
  // Per-candidate transparency (why each ranked where) — to stderr.
  for (const r of rankedRecency) {
    console.error(`[feed-run]   recency rank: ${r.match.title ?? r.match.path} — ${r.rationale}`);
  }
} else if (recency.length > 0) {
  console.error("[feed-run] query-recency: preference signal empty — recency order unchanged (newest-first)");
}

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

// 3b. EXPLORATION SLOT — deterministic anti-monoculture nudge. The preference
//     loop self-reinforces toward whatever earned reactions (a starved format
//     gets no feedback, so no [learned] lines, so it stays starved); every
//     --explore-every'th run the brief reserves one cap slot for the
//     least-recently-produced internal format. Run ordinal = prior run-log
//     lines + 1 (deterministic, no extra state file).
async function latestGeneratedAtByFormat(): Promise<Partial<Record<InternalFeedFormat, string | null>>> {
  const latest: Partial<Record<InternalFeedFormat, string | null>> = {};
  for (const format of INTERNAL_FEED_FORMATS) {
    let newest: string | null = null;
    let slugs: string[] = [];
    try {
      slugs = (await readdir(join(artifactsDir, format), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // format dir doesn't exist yet — never produced
    }
    for (const slug of slugs) {
      try {
        const a = JSON.parse(
          await readFile(join(artifactsDir, format, slug, "artifact.json"), "utf8"),
        ) as { generated_at?: unknown };
        const ts = typeof a.generated_at === "string" ? a.generated_at : null;
        if (ts && !Number.isNaN(Date.parse(ts)) && (newest === null || Date.parse(ts) > Date.parse(newest))) {
          newest = ts;
        }
      } catch {
        // unreadable artifact — skip; the scanner tolerates these too
      }
    }
    latest[format] = newest;
  }
  return latest;
}
let priorRuns = 0;
try {
  // Count ORCHESTRATOR entries only: the launchd wrapper appends its own
  // guard lines ({wrapper_guard, ...}) to the same run-log.jsonl, and counting
  // those would make the "every Nth run" cadence fire on lines, not runs.
  priorRuns = (await readFile(runLogPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      try {
        return !("wrapper_guard" in (JSON.parse(line) as Record<string, unknown>));
      } catch {
        return false;
      }
    }).length;
} catch {
  // no run log yet — first run
}
const explorationFormat =
  explorationPick(priorRuns + 1, exploreEvery, await latestGeneratedAtByFormat()) ?? undefined;

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
  feedbackSummary,
  baselineSummary,
  salientPeople,
  explorationFormat,
});
log(
  "brief",
  "ok",
  `brief prepared (${recency.length} recency + ${deepDive ? 1 : 0} deep-dive, cap ${cap}` +
    `${explorationFormat ? `, exploration slot: ${explorationFormat}` : ""})`,
);

// 5/6. GENERATE + SAVE.
//
//      The orchestrator stops at the brief on --dry-run (the safe default) and
//      on --no-generate (the Generate button's dry preview). WITHOUT either
//      flag, the orchestrator now ACTUALLY runs generation by invoking a
//      generation AGENT HEADLESSLY (`claude -p`, via run-generation.ts) to
//      consume the brief and produce artifacts. This is the orchestration layer
//      — explicitly allowed to invoke the agent CLI; the index/query/feed-run
//      logic above stays LLM-free.
//
//      CURSOR PERSISTENCE (PR#5 review): the orchestrator holds the
//      authoritative advanced cursor (`advance.ledger`) and persists it ITSELF
//      — NOT delegated to the agent. This guarantees the deep-dive cursor moves
//      off the picked thread even on a zero-artifact run (the agent ships
//      nothing → no surfaced entry → without this the same thread is re-picked
//      forever). The agent later appends only surfaced ENTRIES; it must NOT
//      reconstruct the cursor. EXCEPTION: --dry-run never mutates state, so it
//      REPORTS the would-be advance but does not write. Cursor persistence
//      happens BEFORE generation so a crashed/zero-artifact run still rotates.
const runDir = progressRunDir; // index/runs/<sanitized-run-id>
const briefPath = join(runDir, "run-brief.md");
let artifactsPublished: string[] = [];
let draftsProduced: string[] = [];
// PR #8 review enforcement (findings A + B): the human-line guard outcome and
// the distill-skipped flag for the run-log. Undefined unless a real agent
// distill ran (set in the real-generation branch below).
let guardOutcome: "ok" | "violation" | undefined;
let distillSkipped: boolean | undefined;
let distillPendingEvents: number | undefined;

// Persist the advanced cursor authoritatively whenever we are NOT a dry-run
// (both real generation AND --no-generate own the cursor; only --dry-run
// abstains from mutating state).
async function persistCursor(): Promise<void> {
  if (advance.next) {
    await writeLedger(ledgerPath, ledger);
  }
}

if (dryRun) {
  log("generate", "skipped", "--dry-run: stopped after brief (no generation)");
  log(
    "save",
    "skipped",
    advance.next
      ? `--dry-run: nothing published; WOULD advance deep-dive cursor to ${advance.next}${advance.wrapped ? " (wrapped)" : ""} (not persisted)`
      : "--dry-run: nothing published",
  );
} else if (noGenerate) {
  await persistCursor();
  log("generate", "skipped", "--no-generate: brief produced; headless generation skipped (dry preview)");
  log(
    "save",
    advance.next ? "ok" : "skipped",
    advance.next
      ? `deep-dive cursor advanced to ${advance.next}${advance.wrapped ? " (wrapped)" : ""} and persisted; no artifacts (--no-generate)`
      : "no deep-dive this run (cursor unchanged); no artifacts (--no-generate)",
  );
} else {
  // Persist the cursor first (orchestrator-owned, independent of what ships),
  // and write the brief to its run dir so the headless agent can read it.
  await persistCursor();
  await mkdir(runDir, { recursive: true });
  await writeFile(briefPath, brief);

  // FINDING A — DETERMINISTIC HUMAN-LINE GUARD. Snapshot PREFERENCES.md BEFORE
  // the agent touches it (the agent's distill task #1 happens inside the
  // generation call). After the agent writes we ASSERT no human (non-[learned])
  // line changed and RESTORE the file if one did. Snapshot lives in the run dir
  // so it never collides with a concurrent run.
  //
  // NOTE (PR #8): this branch only runs when feed-run.ts is invoked in DIRECT
  // real-generation mode (no --dry-run / no --no-generate). PRODUCTION does not
  // take this path — the launchd plist + Generate button spawn harness/ops/launchd/
  // feedrun.sh, whose `claude -p` agent runs feed-run.ts --no-generate and then
  // self-distills + self-generates. The PRODUCTION guard therefore lives in
  // feedrun.sh, which brackets that `claude -p` call with the same snapshot →
  // check → verify-distill sequence. This in-orchestrator copy is DEFENSE IN
  // DEPTH for the direct-CLI path (and is exercised by the wrapper-flow test in
  // tests/feedrun-wrapper-guard.test.ts, which drives the production sequence).
  const guardSnapshot = join(runDir, "preferences-guard-snapshot.md");
  const snap = runScript([
    "harness/distill-preferences/scripts/guard-preferences.ts",
    "snapshot",
    "--preferences",
    preferencesPath,
    "--snapshot",
    guardSnapshot,
  ]);
  if (!snap.ok) {
    // Snapshot is cheap and should not fail; if it does, log and proceed
    // unguarded rather than abort the whole run (the run still produces value).
    log("guard", "degraded", `pre-distill snapshot failed: ${lastLine(snap.stderr)}`);
  }

  const model = resolveModel(modelArg, process.env);
  // Flip generate→ACTIVE the instant the long agent call starts (it runs for
  // minutes). The UI shows "Generating…" + the artifact count fills within this
  // window. The real terminal generate status is log()'d below once the agent
  // returns; markActive does NOT push a non-terminal status into steps[].
  markActive(
    "generate",
    `invoking headless generation agent (claude -p, model ${model}) against the brief`,
  );
  try {
    const summary = await runGeneration({
      briefPath,
      artifactsDir,
      cap,
      model: modelArg,
      repoRoot: process.cwd(),
      runId,
      logPath: join(runDir, "generation-log.txt"),
    });

    // FINDING A — CHECK. The agent has written; assert the human lines survived.
    // A violation RESTORES PREFERENCES.md from the snapshot (the CLI does it)
    // and we record guard=violation in the run-log.
    if (snap.ok) {
      const check = runScript([
        "harness/distill-preferences/scripts/guard-preferences.ts",
        "check",
        "--preferences",
        preferencesPath,
        "--snapshot",
        guardSnapshot,
      ]);
      if (check.ok) {
        guardOutcome = "ok";
        log("guard", "ok", "human (non-[learned]) lines intact after distill");
      } else {
        guardOutcome = "violation";
        log(
          "guard",
          "failed",
          `human line changed by distill — PREFERENCES.md RESTORED from snapshot. ${lastLine(check.stderr)}`,
        );
      }
    }

    // FINDING B — POST-RUN DISTILL VERIFICATION. Confirm the distill actually
    // happened: if there are new feedback events since the last distill, the
    // [learned] section must have changed OR the agent must have logged an
    // explicit "no change warranted". Otherwise flag distill_skipped=true.
    const verify = runScript([
      "harness/distill-preferences/scripts/verify-distill.ts",
      "--run-id",
      runId,
      "--events",
      "feedback/events.jsonl",
      "--preferences",
      preferencesPath,
      "--cursor",
      "index/distill-cursor.json",
      "--artifacts-dir",
      artifactsDir,
      "--distill-log",
      join(runDir, "generation-log.txt"),
    ]);
    if (verify.ok) {
      try {
        const v = JSON.parse(verify.stdout.trim().split("\n").pop() ?? "{}") as {
          distill_skipped?: boolean;
          pending_events?: number;
          detail?: string;
        };
        distillSkipped = v.distill_skipped === true;
        distillPendingEvents = v.pending_events;
        log(
          "verify-distill",
          distillSkipped ? "degraded" : "ok",
          v.detail ?? (distillSkipped ? "distill skipped with pending events" : "distill verified"),
        );
      } catch {
        log("verify-distill", "degraded", `could not parse verification output: ${lastLine(verify.stdout)}`);
      }
    } else {
      log("verify-distill", "degraded", `verification failed: ${lastLine(verify.stderr)}`);
    }

    artifactsPublished = summary.created.map((c) => `${c.type}/${c.slug}`);
    draftsProduced = (summary.drafts ?? []).map((c) => `${c.type}/${c.slug}`);
    log(
      "generate",
      summary.exit_code === 0 ? "ok" : "degraded",
      summarizeGeneration(summary),
    );
    log(
      "save",
      "ok",
      `${artifactsPublished.length} artifact(s) published` +
        (draftsProduced.length ? `; ${draftsProduced.length} outward draft(s) → approvals tray (pending, not published)` : "") +
        `${advance.next ? `; deep-dive cursor advanced to ${advance.next}${advance.wrapped ? " (wrapped)" : ""} and persisted` : ""}; agent appended surfaced entries (SKILL.md)`,
    );
  } catch (err) {
    // A generation failure drops THIS run's artifacts, not the run (zero
    // artifacts is a valid run). The cursor is already persisted above.
    log("generate", "failed", `headless generation errored: ${String(err).slice(0, 200)}`);
    log("save", "skipped", "no artifacts (generation failed); cursor already persisted");
  }
}

const finalLog = await finish(
  "completed",
  {
    since,
    recency_paths: recency.map((m) => m.path),
    deepdive_path: deepDive?.path,
    deepdive_wrapped: advance.wrapped,
    artifacts_published: artifactsPublished,
    drafts_produced: draftsProduced.length ? draftsProduced : undefined,
    distill_skipped: distillSkipped,
    distill_pending_events: distillPendingEvents,
    guard: guardOutcome,
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
