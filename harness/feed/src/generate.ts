// generate.ts — the gated Generate button (spec §8): POST /api/generate spawns
// the feed-run loop DETACHED and returns 202 + { run_id }; GET
// /api/generate/:run_id reports status by reading index/runs/<run_id>/.
//
// AUTH: this is the HIGHEST-PRIVILEGE route — a full run spends Gemini money
// (TTS + images) and writes to the live feed. It rides the SAME OpenKey gate as
// /api/cards (registered on /api/* in auth.ts), so an unauth POST → 401 before
// any of this runs. dry_run (default false) maps to FEEDRUN_DRY_RUN=1 → a safe
// preview (brief + cursor only, no model calls, no publish).
//
// CONCURRENCY (spec §10 R1): a PID lockfile at index/.run.lock — the same file
// harness/ops/launchd/feedrun.sh holds. A second concurrent run → 409. The lock is the
// single source of truth shared by cron + button.
//
// BOUNDARY: this module spawns the wrapper; it makes NO model calls itself. The
// wrapper (or, for dry_run, feed-run.ts directly) does the work; this just
// orchestrates the detached spawn + reports status off disk.

import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import {
  existsSync,
  readFileSync,
  writeFileSync as writeFileSyncNode,
  unlinkSync as unlinkSyncNode,
  mkdirSync,
} from "node:fs";
import { join, resolve, relative, sep, dirname } from "node:path";

/**
 * The exact charset a run id may contain. Run ids are emitted by the runner as
 * ISO-8601 timestamps (`newRunId` → `Date.toISOString()`, e.g.
 * `2026-06-11T14:00:00.000Z`). On disk the colons are swapped for dashes
 * (`runDirName`), so the on-disk form is `2026-06-11T14-00-00.000Z`. Both forms
 * live entirely within `[0-9A-Za-z._-]` plus `:` — NEVER a slash, dot-dot, or
 * percent-encoding. Anything outside this charset is rejected with 400 BEFORE we
 * touch the filesystem, which structurally closes the `..%2f..%2fsecret`
 * traversal class (decoded `../` contains a `/`, which is not in the charset).
 */
const RUN_ID_RE = /^[0-9A-Za-z:._-]+$/;

/**
 * Is `runId` a syntactically valid run id (the strict allowlist)? Rejects empty
 * strings, anything with a slash / backslash / dot-dot / null byte / percent /
 * whitespace. This is the first gate the GET route applies — a 400 here means we
 * never path-join attacker-controlled input. Belt-and-suspenders with the
 * post-resolve containment assert below.
 */
export function isValidRunId(runId: string): boolean {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 64) return false;
  if (runId.includes("..")) return false; // no traversal segment, even within the charset
  return RUN_ID_RE.test(runId);
}

/** A run id → its sanitized directory name (colons are illegal-ish on disk). */
export function runDirName(runId: string): string {
  return runId.replace(/[:]/g, "-");
}

/**
 * Resolve a run dir under `runsDir` and ASSERT it stays inside `runsDir`.
 * Returns the absolute run dir, or `null` if the resolved path escapes (a
 * defence-in-depth backstop behind `isValidRunId`). The guard is a
 * `path.relative` starts-with check: if the relative path from runsDir to the
 * target begins with `..` (or is absolute), the target is outside.
 */
export function safeRunDir(runsDir: string, runId: string): string | null {
  if (!isValidRunId(runId)) return null;
  const base = resolve(runsDir);
  const target = resolve(base, runDirName(runId));
  const rel = relative(base, target);
  if (rel === "" || rel === "." || (!rel.startsWith(".." + sep) && rel !== ".." && !rel.startsWith("/"))) {
    // `rel === ""` would mean target === base (the runs dir itself), reject that too.
    if (rel === "" || rel === ".") return null;
    return target;
  }
  return null;
}

/** Generate a fresh, sortable, filesystem-safe run id (ISO timestamp). */
export function newRunId(now: Date = new Date()): string {
  return now.toISOString();
}

export interface GenerateRequest {
  mode?: "daily" | "backfill";
  dry_run?: boolean;
}

/** Parsed + validated body. Unknown fields ignored; bad types → error. */
export function parseGenerateBody(raw: unknown): GenerateRequest | { error: string } {
  if (raw === undefined || raw === null) return {}; // empty body = defaults
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object" };
  }
  const b = raw as Record<string, unknown>;
  const out: GenerateRequest = {};
  if (b.mode !== undefined) {
    if (b.mode !== "daily" && b.mode !== "backfill") {
      return { error: 'mode must be "daily" or "backfill"' };
    }
    out.mode = b.mode;
  }
  if (b.dry_run !== undefined) {
    if (typeof b.dry_run !== "boolean") return { error: "dry_run must be a boolean" };
    out.dry_run = b.dry_run;
  }
  return out;
}

/** The status the GET endpoint reports. */
export interface RunStatus {
  run_id: string;
  status: "running" | "done" | "aborted" | "unknown";
  dry_run: boolean;
  mode: "daily" | "backfill";
  started_at: string;
  finished_at?: string;
  /** From the run-log once the run completes: what it published. */
  artifacts_published?: string[];
  /** From the run-log: completed | aborted. */
  outcome?: string;
}

/** The minimal slice of the spawned-process handle the route depends on. */
export interface ChildHandle {
  pid?: number;
  unref(): void;
  on(event: "error", cb: (err: Error) => void): void;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    detached: boolean;
    stdio: "ignore";
    env: Record<string, string | undefined>;
  },
) => ChildHandle;

const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, opts) as unknown as ChildHandle;

export interface GenerateConfig {
  /** Repo root — the wrapper + index/ live under it. */
  repoRoot: string;
  /** Absolute path to harness/ops/launchd/feedrun.sh (the spawn target). */
  wrapperPath?: string;
  /** Absolute lockfile path (default <repoRoot>/index/.run.lock). */
  lockPath?: string;
  /** Absolute runs dir (default <repoRoot>/index/runs). */
  runsDir?: string;
  /** Injected spawn (TEST SEAM). Defaults to a real detached child. */
  spawn?: SpawnFn;
  /** Injected env passed through to the child. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injected clock for the run id. Defaults to Date. */
  now?: () => Date;
}

export interface StartResult {
  ok: true;
  run_id: string;
}
export interface LockedResult {
  ok: false;
  reason: "locked";
  /** Who holds it (best-effort). */
  pid?: number;
}

/**
 * Is a run currently in progress? Reads the PID lockfile and checks the pid is
 * alive. A stale lock (dead pid / unreadable) is treated as NOT held (the
 * wrapper reclaims it on its next start). Never throws.
 */
export function readLock(lockPath: string): { held: boolean; pid?: number } {
  try {
    if (!existsSync(lockPath)) return { held: false };
    const raw = readFileSync(lockPath, "utf8");
    const pid = parseInt(raw.split("\n")[0]!.trim(), 10);
    if (!Number.isInteger(pid)) return { held: false };
    try {
      process.kill(pid, 0); // signal 0 = liveness probe, doesn't kill
      return { held: true, pid };
    } catch {
      return { held: false, pid }; // dead pid → stale lock
    }
  } catch {
    return { held: false };
  }
}

/**
 * ATOMICALLY acquire the run lock (closing the route's TOCTOU window — review
 * High #2). A plain check-then-write (`readLock` then `writeFile`) lets two
 * concurrent POSTs both pass the read and both spawn → double Gemini spend. This
 * does the create with `flag: "wx"` (O_CREAT|O_EXCL) — the OS guarantees exactly
 * one writer wins on `EEXIST`. If the existing lock is STALE (dead pid), it is
 * reclaimed: unlink + retry once (matches the wrapper's stale-lock policy).
 *
 * Returns `{ ok: true }` for the winner, or `{ ok: false, pid }` (the live
 * holder) for the loser → the route maps that to 409. Synchronous create on top
 * of `writeFileSync` so there is no `await` gap between the EEXIST probe and the
 * reclaim.
 */
export function acquireLock(lockPath: string, pid = process.pid): { ok: true } | { ok: false; pid?: number } {
  const payload = `${pid}\n${new Date().toISOString()}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSyncNode(lockPath, payload, { flag: "wx" }); // O_EXCL: atomic create-or-fail
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lock exists — is the holder alive? A live holder loses us the race (409).
      const held = readLock(lockPath);
      if (held.held) return { ok: false, pid: held.pid };
      // Stale lock (dead pid / unreadable). Reclaim it and retry the atomic create.
      try {
        unlinkSyncNode(lockPath);
      } catch {
        // someone else reclaimed it first — loop will EEXIST again or succeed
      }
    }
  }
  // Two reclaim attempts both lost to a concurrent winner — treat as held.
  const held = readLock(lockPath);
  return { ok: false, pid: held.pid };
}

/** Release a lock acquired by `acquireLock`. Best-effort; never throws. */
export function releaseLock(lockPath: string): void {
  try {
    unlinkSyncNode(lockPath);
  } catch {
    /* already gone */
  }
}

/**
 * Start a generation run (POST /api/generate). Checks the lock (409 if held),
 * writes a `running` status record into the run dir, then spawns the wrapper
 * DETACHED (the route returns immediately; the run outlives the request). The
 * run_id is chosen here so the status endpoint can find the dir before the run
 * finishes — it's threaded to feed-run.ts via FEEDRUN_RUN_ID so the orchestrator
 * writes its run-log.json into the SAME dir.
 *
 * NOTE: the lock is held by the WRAPPER (feedrun.sh writes index/.run.lock on
 * start, removes it on exit). The route's pre-check is an early 409 so we don't
 * even spawn; the wrapper's own lock is the authoritative guard against a TOCTOU
 * race (a second wrapper that started in the gap aborts with exit 75).
 */
export async function startGeneration(
  req: GenerateRequest,
  cfg: GenerateConfig,
): Promise<StartResult | LockedResult> {
  const repoRoot = resolve(cfg.repoRoot);
  const lockPath = cfg.lockPath ?? join(repoRoot, "index", ".run.lock");
  const runsDir = cfg.runsDir ?? join(repoRoot, "index", "runs");
  const wrapperPath = cfg.wrapperPath ?? join(repoRoot, "harness", "ops", "launchd", "feedrun.sh");
  const spawn = cfg.spawn ?? defaultSpawn;
  const baseEnv = cfg.env ?? process.env;
  const now = cfg.now ?? (() => new Date());

  // ATOMICALLY claim the lock up front (review High #2): a plain readLock
  // pre-check is check-then-write — two concurrent POSTs both pass it and both
  // spawn (double spend). acquireLock uses O_EXCL so exactly one POST wins; the
  // loser gets 409 here, before any spawn. The wrapper then OVERWRITES this lock
  // with its own run pid on start (handoff) and removes it on exit. We must
  // ensure the lock dir exists for the atomic create.
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    /* dir already exists */
  }
  const acquired = acquireLock(lockPath);
  if (!acquired.ok) return { ok: false, reason: "locked", pid: acquired.pid };

  const mode = req.mode ?? "daily";
  const dryRun = req.dry_run ?? false;
  const runId = newRunId(now());
  const runDir = join(runsDir, runDirName(runId));
  const startedAt = new Date().toISOString();

  // Stamp a `running` status record up front so GET works immediately.
  await mkdir(runDir, { recursive: true });
  const status: RunStatus = {
    run_id: runId,
    status: "running",
    dry_run: dryRun,
    mode,
    started_at: startedAt,
  };
  await writeFile(join(runDir, "status.json"), JSON.stringify(status, null, 2) + "\n");

  // Spawn the wrapper detached: it sources env, holds the lock, runs the recipe
  // (full) or feed-run.ts --no-generate (dry). FEEDRUN_RUN_ID makes feed-run.ts
  // write into THIS run dir.
  const childEnv: Record<string, string | undefined> = {
    ...baseEnv,
    FEEDRUN_MODE: mode,
    FEEDRUN_RUN_ID: runId,
    FEEDRUN_DRY_RUN: dryRun ? "1" : "0",
  };
  let child: ChildHandle;
  try {
    child = spawn("/bin/bash", [wrapperPath], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: childEnv,
    });
  } catch (err) {
    // The spawn itself threw (e.g. ENOENT on the wrapper). Release the lock we
    // atomically claimed so a failed spawn doesn't wedge every future run.
    releaseLock(lockPath);
    throw err;
  }
  // Don't let the child keep the server's event loop tied to it.
  child.on("error", () => {
    // Async spawn failure (ENOENT after the call returned). Release the lock so
    // the server pid we stamped doesn't block future runs forever. The wrapper,
    // had it started, would have overwritten + own the lock; it didn't.
    releaseLock(lockPath);
  });
  child.unref();

  return { ok: true, run_id: runId };
}

/**
 * Read a run's status (GET /api/generate/:run_id). Prefers the orchestrator's
 * own run-log.json (authoritative outcome once the run finishes); falls back to
 * the route's status.json (`running`) while the run is still going; returns
 * `unknown` for an id with no dir. Never throws.
 */
export async function readRunStatus(
  runId: string,
  cfg: Pick<GenerateConfig, "repoRoot" | "runsDir">,
): Promise<RunStatus> {
  const repoRoot = resolve(cfg.repoRoot);
  const runsDir = cfg.runsDir ?? join(repoRoot, "index", "runs");
  // SECURITY: validate + contain BEFORE any path join. An id that fails the
  // strict allowlist or resolves outside runsDir yields no run dir at all — the
  // route surfaces this as a 400 (it pre-checks isValidRunId) and we never read
  // an attacker-chosen path. safeRunDir is the defence-in-depth backstop.
  const runDir = safeRunDir(runsDir, runId);
  if (runDir === null) {
    return {
      run_id: runId,
      status: "unknown",
      dry_run: false,
      mode: "daily",
      started_at: "",
    };
  }

  // The route's own stamp (always written on start).
  let stamp: RunStatus | undefined;
  try {
    stamp = JSON.parse(await readFile(join(runDir, "status.json"), "utf8")) as RunStatus;
  } catch {
    stamp = undefined;
  }

  // The orchestrator's run-log appears once feed-run.ts finishes its bookkeeping.
  // Its presence means the run COMPLETED (the wrapper's claude -p / dry-run
  // returned). For a full headless run the agent's generation may still be
  // writing artifacts, but the orchestrator's run-log is the deterministic
  // completion marker we can observe from here.
  try {
    const runLog = JSON.parse(await readFile(join(runDir, "run-log.json"), "utf8")) as {
      outcome?: string;
      artifacts_published?: string[];
      finished_at?: string;
      dry_run?: boolean;
      mode?: "daily" | "backfill";
      run_id?: string;
    };
    return {
      run_id: runId,
      status: runLog.outcome === "aborted" ? "aborted" : "done",
      dry_run: runLog.dry_run ?? stamp?.dry_run ?? false,
      mode: runLog.mode ?? stamp?.mode ?? "daily",
      started_at: stamp?.started_at ?? "",
      finished_at: runLog.finished_at,
      artifacts_published: runLog.artifacts_published ?? [],
      outcome: runLog.outcome,
    };
  } catch {
    // No run-log yet.
  }

  if (stamp) return stamp;
  return {
    run_id: runId,
    status: "unknown",
    dry_run: false,
    mode: "daily",
    started_at: "",
  };
}

// ===========================================================================
// REAL GENERATION PROGRESS (replaces the indefinite spinner).
//
// Three deterministic-to-soft signals, in robustness order:
//
//   1. STAGE TRACK  — the orchestrator's run-log.json `steps[]` (index → distill
//      → query-recency → query-deepdive → brief → generate → … → save), each
//      {step,status}. Works with ZERO agent cooperation. While the run-log does
//      not yet exist, we show the canonical pipeline as all-pending so the UI has
//      a real skeleton from t=0.
//   2. ARTIFACT COUNT — artifact.json files under <repo>/artifacts/<type>/<slug>/
//      whose mtime is newer than the run's started_at, capped by the brief's
//      MAX_ARTIFACTS_PER_RUN. This is the FILL signal during the Generate stage.
//   3. ACTIVITY LINE — the agent (best-effort) appends one JSON line per step to
//      index/runs/<run_id>/progress.jsonl; we tail the last well-formed line.
//      MUST degrade gracefully: absent/stale → null, never a broken/faked state.
//
// FAILURE + STALENESS: a failed status.json (outcome/status "failed"|"aborted")
// or a run-log outcome "aborted" surfaces as `failed` so the UI stops (kills the
// eternal-'running' dead-run bug). A run whose status says running but whose
// newest signal (run-log, progress.jsonl, status.json, or a fresh artifact) has
// not advanced for > STALE_AFTER_MS surfaces as `stalled` rather than spinning
// forever. NO faked percentage/ETA — the bar only moves on real stage/artifact
// signal.
// ===========================================================================

/** The canonical ordered pipeline the UI renders as a stage track. Kept in sync
 * with feed-run-lib's PIPELINE_STEPS but inlined here so the feed server has no
 * dependency on the feed-run package. */
export const PROGRESS_STEPS = [
  "index",
  "distill",
  "query-recency",
  "query-deepdive",
  "brief",
  "generate",
  "guard",
  "verify-distill",
  "save",
] as const;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];

/** Default artifact cap when the run-log hasn't recorded one yet (daily default). */
export const DEFAULT_RUN_CAP = 3;

/** A run is `stalled` if running but no signal advanced for this long. */
export const STALE_AFTER_MS = 8 * 60 * 1000;

export type ProgressStatus = "running" | "done" | "failed" | "stalled";
export type ProgressStepStatus = "pending" | "ok" | "skipped" | "degraded" | "failed" | "aborted" | "active";

export interface ProgressStage {
  step: string;
  status: ProgressStepStatus;
}

/** The structured progress object the GET endpoint returns (the real UI signal). */
export interface RunProgress {
  run_id: string;
  status: ProgressStatus;
  /** The ordered stage track — always the full canonical pipeline, statuses filled. */
  stages: ProgressStage[];
  /** The step currently in flight (first non-terminal/active), or null when done/failed. */
  current_stage: string | null;
  /** Artifact.json files created since started_at (the fill signal during generate). */
  artifacts_produced: number;
  /** The run's artifact cap (MAX_ARTIFACTS_PER_RUN) from the run-log, or the default. */
  cap: number;
  /** Outward drafts produced (banger / investor-snippet), once the run-log records them. */
  drafts_produced: number;
  /** The last well-formed progress.jsonl line's detail, or null (graceful degrade). */
  latest_activity: string | null;
  /** ISO timestamp the run started (route stamp). */
  started_at: string;
  /** Wall-clock since started_at, ms (0 if no started_at). */
  elapsed_ms: number;
  /** True once the run reached a terminal state (done | failed). NOT true for stalled. */
  done: boolean;
  /** Whether this was a dry-run (preview). */
  dry_run: boolean;
  /** Final published artifact slugs, once the run-log records them. */
  artifacts_published: string[];
}

/** Minimal shape of the orchestrator's run-log.json we read for the stage track. */
interface RunLogShape {
  outcome?: string;
  status?: string;
  cap?: number;
  steps?: { step?: string; status?: string; detail?: string }[];
  artifacts_published?: string[];
  drafts_produced?: string[];
  finished_at?: string;
  dry_run?: boolean;
}

/** Parse the last well-formed JSON object line of a progress.jsonl body. */
export function tailProgressLine(body: string): { ts?: string; detail: string } | null {
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { ts?: string; detail?: unknown };
      if (typeof obj.detail === "string" && obj.detail.length > 0) {
        return { ts: typeof obj.ts === "string" ? obj.ts : undefined, detail: obj.detail };
      }
    } catch {
      // malformed tail line — keep scanning upward for the last good one
    }
  }
  return null;
}

/**
 * Merge the canonical pipeline with the run-log's recorded steps, marking the
 * first not-yet-terminal step as `active` while the run is still going. Steps the
 * run-log hasn't reached stay `pending`. Deterministic; no agent cooperation.
 */
export function buildStages(
  loggedSteps: { step?: string; status?: string }[] | undefined,
  runIsTerminal: boolean,
): { stages: ProgressStage[]; current: string | null } {
  const byStep = new Map<string, string>();
  for (const s of loggedSteps ?? []) {
    if (typeof s.step === "string" && typeof s.status === "string") byStep.set(s.step, s.status);
  }
  const TERMINAL_STEP = new Set(["ok", "skipped", "degraded", "failed", "aborted"]);
  const stages: ProgressStage[] = PROGRESS_STEPS.map((step) => {
    const logged = byStep.get(step);
    return { step, status: (logged as ProgressStepStatus) ?? "pending" };
  });

  // The current stage = the first stage that is not terminal. If the run itself
  // is terminal we mark no active stage (everything resolved). Otherwise the
  // first pending stage becomes `active` so the UI shows a live cursor even
  // before the orchestrator logs that step.
  let current: string | null = null;
  if (!runIsTerminal) {
    for (const s of stages) {
      if (!TERMINAL_STEP.has(s.status)) {
        if (s.status === "pending") s.status = "active";
        current = s.step;
        break;
      }
    }
  }
  return { stages, current };
}

/**
 * Count artifact.json files under artifactsDir whose mtime is at/after `sinceMs`,
 * and report the NEWEST such mtime (0 if none). The newest mtime is folded into
 * the staleness `freshest` floor so a healthy long generate that is still landing
 * artifacts is never false-stalled (review finding #3b). Returns both in one walk.
 */
export async function countArtifactsSince(
  artifactsDir: string,
  sinceMs: number,
): Promise<{ count: number; newestMtimeMs: number }> {
  let count = 0;
  let newestMtimeMs = 0;
  let types: { name: string; isDirectory(): boolean }[];
  try {
    types = await readdir(artifactsDir, { withFileTypes: true });
  } catch {
    return { count: 0, newestMtimeMs: 0 }; // no artifacts dir yet
  }
  for (const t of types) {
    if (!t.isDirectory()) continue;
    let slugs: { name: string; isDirectory(): boolean }[];
    try {
      slugs = await readdir(join(artifactsDir, t.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const af = join(artifactsDir, t.name, slug.name, "artifact.json");
      try {
        const st = await stat(af);
        // mtime tolerance: a 1s clock-skew grace so an artifact written in the
        // same second as started_at still counts (mtime resolution + write lag).
        if (st.mtimeMs >= sinceMs - 1000) {
          count += 1;
          if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
        }
      } catch {
        // no artifact.json in this slug dir — skip
      }
    }
  }
  return { count, newestMtimeMs };
}

/**
 * Aggregate the real progress object (GET /api/generate/:run_id). Reuses the
 * path-safe run-id guard, reads run-log.json (stages + cap + outcome),
 * progress.jsonl (activity tail), status.json (start time + failed flag), and
 * counts fresh artifacts. Never throws — every read is defensive.
 *
 * Terminal mapping:
 *   - run-log outcome "completed"           → done
 *   - run-log outcome "aborted" | status.json status "failed"/"aborted"
 *     | progress/status "failed"            → failed  (UI stops; no eternal spin)
 *   - status running but no signal advanced for > STALE_AFTER_MS → stalled
 *   - otherwise                             → running
 */
export async function readRunProgress(
  runId: string,
  cfg: Pick<GenerateConfig, "repoRoot" | "runsDir"> & { artifactsDir?: string },
  now: () => number = () => Date.now(),
): Promise<RunProgress> {
  const repoRoot = resolve(cfg.repoRoot);
  const runsDir = cfg.runsDir ?? join(repoRoot, "index", "runs");
  const artifactsDir = cfg.artifactsDir ?? join(repoRoot, "artifacts");
  const nowMs = now();

  const empty: RunProgress = {
    run_id: runId,
    status: "failed",
    stages: PROGRESS_STEPS.map((step) => ({ step, status: "pending" as ProgressStepStatus })),
    current_stage: null,
    artifacts_produced: 0,
    cap: DEFAULT_RUN_CAP,
    drafts_produced: 0,
    latest_activity: null,
    started_at: "",
    elapsed_ms: 0,
    done: true,
    dry_run: false,
    artifacts_published: [],
  };

  const runDir = safeRunDir(runsDir, runId);
  if (runDir === null) return { ...empty, status: "failed" };

  // status.json — the route's own stamp (start time, dry_run, possible failure).
  let stamp: (RunStatus & { status?: string }) | undefined;
  let stampMtimeMs = 0;
  try {
    stamp = JSON.parse(await readFile(join(runDir, "status.json"), "utf8")) as RunStatus;
    try {
      stampMtimeMs = (await stat(join(runDir, "status.json"))).mtimeMs;
    } catch {
      /* ignore */
    }
  } catch {
    stamp = undefined;
  }

  // No stamp AND no run dir signal → unknown run; the route maps this to 404.
  // We represent it as a failed/done empty with started_at "" so the route can
  // detect "no such run". (readRunStatus stays the 404 oracle; this is a backstop.)
  const startedAt = stamp?.started_at ?? "";
  const startedMs = startedAt ? Date.parse(startedAt) : 0;

  // run-log.json — the orchestrator's stage track + outcome + cap.
  let runLog: RunLogShape | undefined;
  let runLogMtimeMs = 0;
  try {
    runLog = JSON.parse(await readFile(join(runDir, "run-log.json"), "utf8")) as RunLogShape;
    try {
      runLogMtimeMs = (await stat(join(runDir, "run-log.json"))).mtimeMs;
    } catch {
      /* ignore */
    }
  } catch {
    runLog = undefined;
  }

  // progress.jsonl — the soft activity tail (best-effort, may be absent).
  let latestActivity: string | null = null;
  let progressMtimeMs = 0;
  try {
    const body = await readFile(join(runDir, "progress.jsonl"), "utf8");
    const tail = tailProgressLine(body);
    latestActivity = tail?.detail ?? null;
    try {
      progressMtimeMs = (await stat(join(runDir, "progress.jsonl"))).mtimeMs;
    } catch {
      /* ignore */
    }
  } catch {
    latestActivity = null; // graceful degrade — no activity line, never broken
  }

  // Artifact fill signal (count fresh artifact.json since started_at). The newest
  // artifact mtime feeds the staleness floor below so a run still landing
  // artifacts is never false-stalled.
  const artifactScan =
    startedMs > 0
      ? await countArtifactsSince(artifactsDir, startedMs)
      : { count: 0, newestMtimeMs: 0 };
  const artifactsProduced = artifactScan.count;

  // ---- terminal / status resolution -------------------------------------
  const stampStatus = (stamp?.status ?? "").toLowerCase();
  const runLogOutcome = (runLog?.outcome ?? "").toLowerCase();
  const runLogStatus = (runLog?.status ?? "").toLowerCase();

  const isFailed =
    stampStatus === "failed" ||
    stampStatus === "aborted" ||
    runLogOutcome === "aborted" ||
    runLogStatus === "failed" ||
    runLogStatus === "aborted";
  const isDone = runLogOutcome === "completed" || runLogStatus === "completed" || runLogStatus === "done";

  let status: ProgressStatus;
  if (isFailed) status = "failed";
  else if (isDone) status = "done";
  else status = "running";

  // Staleness: only meaningful while still "running". The freshest signal mtime
  // bounds how long we've gone without movement. We now fold in (a) the newest
  // artifact mtime — a run still landing artifacts IS alive (review finding #3b:
  // the old code claimed fresh artifacts counted as liveness but never folded
  // their mtime in), and (b) the incremental run-log mtime, which now genuinely
  // advances per pipeline step (fix #1) — so a healthy run is no longer
  // false-stalled the moment it crosses the 8-min floor between deterministic
  // steps. startedMs remains the floor.
  if (status === "running") {
    const freshest = Math.max(
      runLogMtimeMs,
      progressMtimeMs,
      stampMtimeMs,
      artifactScan.newestMtimeMs,
      startedMs,
    );
    if (freshest > 0 && nowMs - freshest > STALE_AFTER_MS) {
      status = "stalled";
    }
  }

  const runIsTerminal = status === "done" || status === "failed";
  const { stages, current } = buildStages(runLog?.steps, runIsTerminal);

  return {
    run_id: runId,
    status,
    stages,
    current_stage: current,
    artifacts_produced: artifactsProduced,
    cap: typeof runLog?.cap === "number" ? runLog.cap : DEFAULT_RUN_CAP,
    drafts_produced: runLog?.drafts_produced?.length ?? 0,
    latest_activity: latestActivity,
    started_at: startedAt,
    elapsed_ms: startedMs > 0 ? Math.max(0, nowMs - startedMs) : 0,
    done: runIsTerminal,
    dry_run: runLog?.dry_run ?? stamp?.dry_run ?? false,
    artifacts_published: runLog?.artifacts_published ?? [],
  };
}

/** List recent run ids (newest first) — handy for a future history view; unused by v1 UI. */
export async function listRuns(
  cfg: Pick<GenerateConfig, "repoRoot" | "runsDir">,
  limit = 20,
): Promise<string[]> {
  const repoRoot = resolve(cfg.repoRoot);
  const runsDir = cfg.runsDir ?? join(repoRoot, "index", "runs");
  try {
    const dirs = (await readdir(runsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    return dirs.slice(0, limit);
  } catch {
    return [];
  }
}
