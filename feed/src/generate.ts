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
// ops/launchd/feedrun.sh holds. A second concurrent run → 409. The lock is the
// single source of truth shared by cron + button.
//
// BOUNDARY: this module spawns the wrapper; it makes NO model calls itself. The
// wrapper (or, for dry_run, feed-run.ts directly) does the work; this just
// orchestrates the detached spawn + reports status off disk.

import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** A run id → its sanitized directory name (colons are illegal-ish on disk). */
export function runDirName(runId: string): string {
  return runId.replace(/[:]/g, "-");
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
  /** Absolute path to ops/launchd/feedrun.sh (the spawn target). */
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
  const wrapperPath = cfg.wrapperPath ?? join(repoRoot, "ops", "launchd", "feedrun.sh");
  const spawn = cfg.spawn ?? defaultSpawn;
  const baseEnv = cfg.env ?? process.env;
  const now = cfg.now ?? (() => new Date());

  const lock = readLock(lockPath);
  if (lock.held) return { ok: false, reason: "locked", pid: lock.pid };

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
  const child = spawn("/bin/bash", [wrapperPath], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    env: childEnv,
  });
  // Don't let the child keep the server's event loop tied to it.
  child.on("error", () => {
    /* spawn failure surfaces via the status never flipping to done; logged by launchd in prod */
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
  const runDir = join(runsDir, runDirName(runId));

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
