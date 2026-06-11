// surfaced-ledger.ts — the persisted "already surfaced" ledger + deep-dive
// cursor (spec §3 / §5). Deterministic plumbing only — no model calls, no
// judgment. The recipe (Layer 2) decides WHAT to record; this file only
// reads/writes the ledger and computes the cursor's mechanical advance/wrap.
//
// The ledger is one half of the "already surfaced" join. The other half is the
// prior-artifact baseline (novelty.ts `priorArtifactIndex`). query-corpus
// unions the two (see query-corpus.ts). The ledger also persists the rotating
// deep-dive cursor the feed-run recipe advances once per run.
//
// Persistence: `index/surfaced.json` at repo root, gitignored (it records
// meeting paths + topic keys — derived personal data, same stance as
// artifacts/ and the corpus index).

import { readFile, rename } from "node:fs/promises";

/** Ledger schema version. Bump when an entry's shape changes incompatibly. */
export const LEDGER_VERSION = 1;

/** What happened to a transcript a run examined. */
export type SurfacedOutcome = "shipped" | "examined-no-ship";

/** Which selection mode surfaced it. */
export type SurfacedMode = "recency" | "deepdive" | "backfill";

/** One ledger entry: a transcript a run examined, and what it did with it. */
export interface SurfacedEntry {
  /** Absolute path of the transcript (the join key against the index). */
  path: string;
  /** Topic keys the run attached (e.g. "openkey,permissioning"). Free-form. */
  topic_keys: string[];
  /** The run that recorded this (ISO-ish run id). */
  run_id: string;
  outcome: SurfacedOutcome;
  mode: SurfacedMode;
  /**
   * The transcript's content_hash at surfacing time (R3): if a transcript is
   * later edited, its index hash changes and the recipe MAY re-offer it. Stored
   * so that decision is possible; query-corpus does not act on it by default.
   */
  content_hash?: string;
}

/** The rotating deep-dive cursor (spec §5). */
export interface DeepDiveCursor {
  /** Path of the last transcript the deep-dive examined; selection resumes after it. */
  last_path?: string;
}

export interface SurfacedLedger {
  version: number;
  deepdive_cursor: DeepDiveCursor;
  surfaced: SurfacedEntry[];
}

/** A fresh, empty ledger (used when the file is absent/corrupt). */
export function emptyLedger(): SurfacedLedger {
  return { version: LEDGER_VERSION, deepdive_cursor: {}, surfaced: [] };
}

/**
 * Read the ledger, or an empty one if it's absent / unreadable / malformed.
 * Never throws (matching `priorArtifactIndex` / `readIndex`): a lost ledger
 * just means "nothing recorded yet" — the prior-artifact baseline still holds
 * the authoritative surfaced record, so we degrade safely.
 */
export async function readLedger(path: string): Promise<SurfacedLedger> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SurfacedLedger>;
    if (parsed && Array.isArray(parsed.surfaced)) {
      return {
        version: typeof parsed.version === "number" ? parsed.version : LEDGER_VERSION,
        deepdive_cursor:
          parsed.deepdive_cursor && typeof parsed.deepdive_cursor === "object"
            ? { last_path: parsed.deepdive_cursor.last_path }
            : {},
        surfaced: parsed.surfaced.filter(
          (e): e is SurfacedEntry =>
            !!e && typeof (e as SurfacedEntry).path === "string",
        ),
      };
    }
  } catch {
    // Missing or corrupt ledger → empty (the artifact baseline still applies).
  }
  return emptyLedger();
}

/** Write the ledger atomically (tmp + rename), the index/app.ts pattern. */
export async function writeLedger(path: string, ledger: SurfacedLedger): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(ledger, null, 2) + "\n");
  await rename(tmp, path);
}

/**
 * Append a surfaced entry (pure — returns a new ledger). The recipe calls this
 * after each run for every transcript it examined. Entries accumulate (an
 * append log); the same path can appear multiple times across runs.
 */
export function appendSurfaced(ledger: SurfacedLedger, entry: SurfacedEntry): SurfacedLedger {
  return { ...ledger, surfaced: [...ledger.surfaced, entry] };
}

/** The set of paths the ledger has ever surfaced (either outcome). */
export function ledgerSurfacedPaths(ledger: SurfacedLedger): Set<string> {
  return new Set(ledger.surfaced.map((e) => e.path));
}

/**
 * Map path → the ledger entries that surfaced it (newest run last, in append
 * order). Used by query-corpus to build the `surfaced_by` provenance list.
 */
export function ledgerEntriesByPath(ledger: SurfacedLedger): Map<string, SurfacedEntry[]> {
  const m = new Map<string, SurfacedEntry[]>();
  for (const e of ledger.surfaced) {
    const list = m.get(e.path) ?? [];
    list.push(e);
    m.set(e.path, list);
  }
  return m;
}

/**
 * Advance the rotating deep-dive cursor over an ORDERED candidate list (spec
 * §5). The recipe passes the candidate paths it considers eligible, already
 * sorted in its stable order (date then path). Semantics:
 *
 *   - Find the current cursor (`last_path`) in the list.
 *   - The "next" candidate is the one AFTER it.
 *   - If the cursor is at/after the end, or not found, WRAP to the first
 *     candidate (index 0).
 *   - An empty candidate list yields `next: undefined` and an unchanged cursor.
 *
 * This is the mechanical advance only. Re-eligibility (skipping already-
 * surfaced transcripts) is the caller's job via the surfaced join — the recipe
 * passes only `--unsurfaced-only` candidates, so wrapping never re-surfaces.
 * Returns the chosen `next` path AND the ledger with its cursor moved to it.
 */
export function advanceCursor(
  ledger: SurfacedLedger,
  orderedCandidates: string[],
): { next?: string; ledger: SurfacedLedger; wrapped: boolean } {
  if (orderedCandidates.length === 0) {
    return { next: undefined, ledger, wrapped: false };
  }
  const last = ledger.deepdive_cursor.last_path;
  let next: string;
  let wrapped: boolean;
  if (last === undefined) {
    // No cursor yet — start at the beginning (first run is not a wrap).
    next = orderedCandidates[0]!;
    wrapped = false;
  } else {
    const idx = orderedCandidates.indexOf(last);
    if (idx === -1 || idx + 1 >= orderedCandidates.length) {
      // Cursor points past the end, or at a path no longer in the candidate
      // set → wrap to the first candidate.
      next = orderedCandidates[0]!;
      wrapped = true;
    } else {
      next = orderedCandidates[idx + 1]!;
      wrapped = false;
    }
  }
  return {
    next,
    ledger: { ...ledger, deepdive_cursor: { last_path: next } },
    wrapped,
  };
}
