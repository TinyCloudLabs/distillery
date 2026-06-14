// runs.ts — durable per-run state for GET /agent/run/:id. Each run is a dir
// under config.runsDir/<run_id>/ with a status.json the server rewrites as the
// pipeline advances. Disk-backed so a poll survives a server restart mid-run
// (the run itself is in-process, so a restart marks an unfinished run as error
// on next read — see reconcile()).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import type { RunState, RunStatus, PublishedRef } from "./runner.ts";

/** A light per-run summary for GET /agent/runs (drops the heavy `log` array). */
export interface RunSummary {
  run_id: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  published?: PublishedRef[];
  error?: string;
}

function runDir(runId: string): string {
  return join(config.runsDir, runId);
}

function statusPath(runId: string): string {
  return join(runDir(runId), "status.json");
}

/** A fresh queued run record + its on-disk home. */
export function createRun(): RunState {
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

/** Persist the run's current state (called after every stage). */
export function writeRun(state: RunState): void {
  mkdirSync(runDir(state.run_id), { recursive: true, mode: 0o700 });
  writeFileSync(statusPath(state.run_id), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** Read a run's state, or null if unknown. */
export function readRun(runId: string): RunState | null {
  const path = statusPath(runId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RunState;
  } catch {
    return null;
  }
}

/** Run ids are server-minted; reject anything that could escape runsDir. */
export function isValidRunId(runId: string): boolean {
  return /^run-\d+-[a-z0-9]{6}$/.test(runId);
}

const RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "done", "error"];

/**
 * Defensively map a parsed status.json to a RunSummary, or null if it isn't
 * structurally a RunState. readRun only guarantees the JSON parsed — a parseable
 * but wrong-shaped record (missing/null/non-array `published`, wrong-typed
 * `status`/`startedAt`) must NOT crash the list, so we type-guard the
 * load-bearing fields and coerce `published` rather than touching `.length` on
 * an arbitrary value.
 */
function toSummary(state: RunState): RunSummary | null {
  const { run_id, status, startedAt, finishedAt, published, error } = state;
  if (typeof run_id !== "string" || !RUN_STATUSES.includes(status)) return null;
  if (typeof startedAt !== "number") return null;
  const published_ = Array.isArray(published) && published.length > 0 ? published : undefined;
  return {
    run_id,
    status,
    startedAt,
    ...(typeof finishedAt === "number" ? { finishedAt } : {}),
    ...(published_ ? { published: published_ } : {}),
    ...(typeof error === "string" && error ? { error } : {}),
  };
}

/**
 * Recent runs (newest first, capped) for GET /agent/runs — so a client can
 * detect an in-progress build. Each entry drops the heavy `log` to keep the
 * list light. RESILIENT: a run dir with a missing/corrupt/structurally-bad
 * status.json is skipped (readRun/toSummary returns null), never throwing the
 * whole list. If runsDir doesn't exist yet (no run has ever started), returns [].
 *
 * BOUNDED WORK: run ids are `run-<startedAtMs>-<rand>`, so the dir-name lexical
 * order ≈ chronological. We sort the entry NAMES descending and read/parse only
 * until we have `limit` valid summaries (with a small margin to absorb skipped
 * corrupt files) — NOT the whole history — so the cost is ~O(limit), not
 * O(total runs). A final sort by startedAt keeps strict newest-first.
 *
 * STALENESS: a "running"/"queued" summary can be stale after a server restart
 * (the run is in-process, so a restart leaves its last-written status frozen).
 * There's no reconcile() here yet — the front end's poll on GET /agent/run/:id
 * is what resolves a stalled run for the user.
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
