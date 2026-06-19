// runs.ts — durable per-run state for GET /agent/run/:id. Each run is a dir
// under config.runsDir/<run_id>/ with a status.json the server rewrites as the
// pipeline advances. Disk-backed so a poll survives a server restart mid-run.
// The run itself is in-process, so a restart can leave a frozen queued/running
// status; readRun/listRuns reconcile those stale records to error once their
// last log heartbeat ages past config.runStaleMs.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import type { RunMediaSummary, RunState, RunStatus, PublishedRef } from "./runner.ts";

const RUN_SUMMARY_LOG_TAIL = 8;

/** A light per-run summary for GET /agent/runs (keeps only a bounded log tail). */
export interface RunSummary {
  run_id: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  published?: PublishedRef[];
  media?: RunMediaSummary;
  error?: string;
  log?: string[];
}

export interface RunLock {
  run_id: string;
  owner: string;
  pid: number;
  acquiredAt: number;
}

export interface RunLockSummary extends RunLock {
  ageMs: number;
  reclaimable: boolean;
}

export type RunLockResult =
  | { ok: true; lock: RunLock }
  | { ok: false; activeRunId: string; message: string };

function runDir(runId: string): string {
  return join(config.runsDir, runId);
}

function statusPath(runId: string): string {
  return join(runDir(runId), "status.json");
}

function lockPath(): string {
  return join(config.runsDir, "agent-run.lock");
}

/** A fresh queued run record + its on-disk home. */
export function createRun(runId = createRunId()): RunState {
  const state: RunState = {
    run_id: runId,
    status: "queued",
    published: [],
    startedAt: Date.now(),
    log: [],
  };
  mkdirSync(runDir(runId), { recursive: true, mode: 0o700 });
  writeRun(state);
  return state;
}

export function createRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Persist the run's current state (called after every stage). */
export function writeRun(state: RunState): void {
  mkdirSync(runDir(state.run_id), { recursive: true, mode: 0o700 });
  writeFileSync(statusPath(state.run_id), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function acquireRunLock(
  runId: string,
  owner: string,
  now = Date.now(),
): RunLockResult {
  mkdirSync(config.runsDir, { recursive: true, mode: 0o700 });
  const path = lockPath();
  const lock: RunLock = {
    run_id: runId,
    owner,
    pid: process.pid,
    acquiredAt: now,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(lock, null, 2) + "\n", "utf-8");
      return { ok: true, lock };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readRunLock();
      if (!existing) {
        try {
          unlinkSync(path);
          continue;
        } catch {
          // A competing process may have already replaced it; report busy below.
        }
      }
      const activeRunId = existing?.run_id ?? "unknown";
      if (existing && canReclaimRunLock(existing, now)) {
        try {
          unlinkSync(path);
          continue;
        } catch {
          // Another process may have removed/replaced it; fall through to busy.
        }
      }
      return {
        ok: false,
        activeRunId,
        message: `A run is already in progress (${activeRunId}).`,
      };
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  return {
    ok: false,
    activeRunId: readRunLock()?.run_id ?? "unknown",
    message: "A run is already in progress.",
  };
}

export function releaseRunLock(runId: string): void {
  const existing = readRunLock();
  if (!existing || existing.run_id !== runId) return;
  try {
    unlinkSync(lockPath());
  } catch {
    // best effort
  }
}

export function readRunLock(): RunLock | null {
  const path = lockPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<RunLock>;
    if (
      typeof parsed.run_id === "string" &&
      typeof parsed.owner === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.acquiredAt === "number"
    ) {
      return parsed as RunLock;
    }
  } catch {
    return null;
  }
  return null;
}

export function canReclaimRunLock(
  lock: RunLock,
  now = Date.now(),
  staleMs = config.runStaleMs,
): boolean {
  const state = isValidRunId(lock.run_id) ? readRun(lock.run_id) : null;
  if (state) {
    return state.status === "done" || state.status === "error";
  }
  return Number.isFinite(staleMs) && staleMs > 0 && now - lock.acquiredAt >= staleMs;
}

export function summarizeRunLock(lock: RunLock, now = Date.now()): RunLockSummary {
  return {
    ...lock,
    ageMs: Math.max(0, now - lock.acquiredAt),
    reclaimable: canReclaimRunLock(lock, now),
  };
}

export function getRunLockSummary(now = Date.now()): RunLockSummary | null {
  const lock = readRunLock();
  return lock ? summarizeRunLock(lock, now) : null;
}

/** Read a run's state, or null if unknown. */
export function readRun(runId: string): RunState | null {
  const path = statusPath(runId);
  if (!existsSync(path)) return null;
  let parsed: RunState;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as RunState;
  } catch {
    return null;
  }
  const { state, changed } = reconcileStaleRun(parsed);
  if (changed) {
    try {
      writeRun(state);
    } catch {
      // Return the reconciled state even if this process cannot persist it
      // (for example, a restricted sandbox probing a home-dir run record).
      // The real server normally has write access and will persist on read.
    }
  }
  return state;
}

/** Run ids are server-minted; reject anything that could escape runsDir. */
export function isValidRunId(runId: string): boolean {
  return /^run-\d+-[a-z0-9]{6}$/.test(runId);
}

const RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "done", "error"];

export function reconcileStaleRun(
  state: RunState,
  now = Date.now(),
  staleMs = config.runStaleMs,
): { state: RunState; changed: boolean } {
  if (state.status !== "queued" && state.status !== "running") {
    return { state, changed: false };
  }
  if (!Number.isFinite(staleMs) || staleMs <= 0) {
    return { state, changed: false };
  }
  const lastProgressAt = lastRunProgressAt(state);
  if (!Number.isFinite(lastProgressAt) || now - lastProgressAt < staleMs) {
    return { state, changed: false };
  }

  const staleMinutes = Math.max(1, Math.round((now - lastProgressAt) / 60_000));
  const priorStatus = state.status;
  const error =
    `Run became stale after ${staleMinutes} min without progress ` +
    `(last status: ${priorStatus}). The agent process likely restarted or lost ` +
    `its child process; start a new run.`;
  const reconciled: RunState = {
    ...state,
    status: "error",
    error,
    finishedAt: now,
    log: [...(Array.isArray(state.log) ? state.log : []), `${new Date(now).toISOString()} ERROR: ${error}`],
  };
  return { state: reconciled, changed: true };
}

function lastRunProgressAt(state: RunState): number {
  const logs = Array.isArray(state.log) ? state.log : [];
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    if (typeof line !== "string") continue;
    const stamp = line.slice(0, 24);
    const parsed = Date.parse(stamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return typeof state.startedAt === "number" ? state.startedAt : 0;
}

/**
 * Defensively map a parsed status.json to a RunSummary, or null if it isn't
 * structurally a RunState. readRun only guarantees the JSON parsed — a parseable
 * but wrong-shaped record (missing/null/non-array `published`, wrong-typed
 * `status`/`startedAt`) must NOT crash the list, so we type-guard the
 * load-bearing fields and coerce `published` rather than touching `.length` on
 * an arbitrary value.
 */
function toSummary(state: RunState): RunSummary | null {
  const { run_id, status, startedAt, finishedAt, published, error, log } = state;
  if (typeof run_id !== "string" || !RUN_STATUSES.includes(status)) return null;
  if (typeof startedAt !== "number") return null;
  const published_ = Array.isArray(published) && published.length > 0 ? published : undefined;
  const log_ = Array.isArray(log) ? log.slice(-RUN_SUMMARY_LOG_TAIL) : [];
  return {
    run_id,
    status,
    startedAt,
    ...(typeof finishedAt === "number" ? { finishedAt } : {}),
    ...(published_ ? { published: published_ } : {}),
    ...(published_ ? { media: summarizePublishedMedia(published_) } : {}),
    ...(typeof error === "string" && error ? { error } : {}),
    ...(log_.length > 0 ? { log: log_ } : {}),
  };
}

export function summarizePublishedMedia(published: PublishedRef[] | undefined): RunMediaSummary {
  const summary: RunMediaSummary = { heroImages: 0, audio: 0, video: 0 };
  for (const artifact of Array.isArray(published) ? published : []) {
    if (artifact?.media?.heroImage) summary.heroImages += 1;
    if (artifact?.media?.audio) summary.audio += 1;
    if (artifact?.media?.video) summary.video += 1;
  }
  return summary;
}

/**
 * Recent runs (newest first, capped) for GET /agent/runs — so a client can
 * detect an in-progress build. Each entry keeps only a small `log` tail to keep
 * the list light. RESILIENT: a run dir with a missing/corrupt/structurally-bad
 * status.json is skipped (readRun/toSummary returns null), never throwing the
 * whole list. If runsDir doesn't exist yet (no run has ever started), returns [].
 *
 * BOUNDED WORK: run ids are `run-<startedAtMs>-<rand>`, so the dir-name lexical
 * order ≈ chronological. We sort the entry NAMES descending and read/parse only
 * until we have `limit` valid summaries (with a small margin to absorb skipped
 * corrupt files) — NOT the whole history — so the cost is ~O(limit), not
 * O(total runs). A final sort by startedAt keeps strict newest-first.
 *
 * STALENESS: readRun reconciles a frozen queued/running record to error when
 * its last log timestamp is older than config.runStaleMs, so listRuns cannot
 * keep advertising abandoned runs forever after a restart/crash/lost child.
 */
export function listRuns(limit = 25): RunSummary[] {
  if (!existsSync(config.runsDir)) return [];
  const names = readdirSync(config.runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isValidRunId(e.name))
    .map((e) => e.name)
    .sort()
    .reverse(); // newest first (lexical ≈ chronological for run-<ms>-<rand>)

  const summaries: RunSummary[] = [];
  // Read newest-first until we have `limit` valid summaries, tolerating up to
  // `skipsLeft` skipped corrupt/bad-shape files to backfill the page — but NEVER
  // the whole history (a dir full of bad files stops after the skip budget).
  let skipsLeft = 5;
  for (const name of names) {
    if (summaries.length >= limit) break;
    let summary: RunSummary | null = null;
    try {
      const state = readRun(name);
      summary = state ? toSummary(state) : null;
    } catch {
      summary = null; // backstop — one bad file never throws the list
    }
    if (summary) summaries.push(summary);
    else if (--skipsLeft < 0) break; // out of skip budget — don't scan further
  }

  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return summaries.slice(0, limit);
}
