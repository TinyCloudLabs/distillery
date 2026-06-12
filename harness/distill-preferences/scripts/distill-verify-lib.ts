// distill-verify-lib.ts — DETERMINISTIC post-run verification that the distill
// actually happened (PR #8 review finding B). Pure, testable plumbing — no
// model calls, no I/O at import time. The CLI wrapper (verify-distill.ts) reads
// the event log / PREFERENCES.md / cursor file and writes the cursor back; this
// module holds the decision logic.
//
// THE PROBLEM: the recipe mandates distill-preferences as the agent's FIRST
// task, but "the agent said it ran" is not proof. A headless run can skip it
// silently (the agent forgets, errors, or no-ops), and the feed quietly stops
// learning. We don't trust "completed" — we VERIFY.
//
// THE VERIFICATION (deterministic): track a CURSOR — the timestamp of the
// newest feedback event consumed at the last distill, plus a fingerprint of the
// [learned] section at that time. On a new run, AFTER the agent's distill task:
//   - If there are NO new events since the cursor → nothing to distill; PASS.
//   - If there ARE new events, the agent must have EITHER changed the [learned]
//     lines (fingerprint differs) OR explicitly logged "no change warranted, N
//     events below threshold" in the distill-log. If NEITHER, the distill was
//     SKIPPED with pending events → flag distill_skipped=true (don't silently
//     pass). The cursor only advances when the distill is verified, so a skipped
//     run's pending events stay pending until a real distill consumes them.
//
// The [learned] fingerprint is the multiset of [learned] bullet lines (trimmed,
// sorted) — order-independent so reordering bullets is not a false "changed",
// but any add/edit/remove of a bullet flips it. Reusing the same reserved-prefix
// contract as the guard keeps "what counts as a learned line" defined once.

import { isLearnedBullet, normalizeNewlines } from "./preferences-guard-lib.ts";

/** Persisted cursor schema version. Bump on incompatible shape changes. */
export const DISTILL_CURSOR_VERSION = 1;

/**
 * The distill cursor (persisted at index/distill-cursor.json, gitignored —
 * derived personal data, same stance as surfaced.json). It records HOW FAR the
 * distill has consumed the event log and WHAT the [learned] section looked like
 * at that point, so the next run can tell whether pending events were acted on.
 */
export interface DistillCursor {
  version: number;
  /**
   * ISO timestamp of the newest feedback event consumed at the last VERIFIED
   * distill. New events are those with ts strictly greater than this. Undefined
   * before the first distill (everything is then "new").
   */
  last_event_ts?: string;
  /** Fingerprint of the [learned] section at the last verified distill. */
  learned_fingerprint?: string;
  /** run_id of the last verified distill (provenance for the run-log). */
  last_run_id?: string;
  /** ISO timestamp the cursor was last written. */
  updated_at?: string;
}

/** A fresh, empty cursor (before any distill has run). */
export function emptyCursor(): DistillCursor {
  return { version: DISTILL_CURSOR_VERSION };
}

/**
 * Order-independent fingerprint of the [learned] section: the trimmed [learned]
 * bullet lines, sorted and newline-joined. Reordering bullets does not change
 * it; any add / edit / remove does. (Trimming leading whitespace matches the
 * guard's treatment of indented learned sub-bullets.)
 */
export function learnedFingerprint(preferences: string): string {
  return normalizeNewlines(preferences)
    .split("\n")
    .filter(isLearnedBullet)
    .map((l) => l.replace(/^\s+/, "").trimEnd())
    .sort()
    .join("\n");
}

/**
 * Count events strictly newer than the cursor (Date.parse comparison so mixed
 * ISO forms order by instant, not lexically — matching feedback.ts). An event
 * with an unparseable ts is conservatively counted as new (better to over-flag
 * a skipped distill than to silently drop a pending event).
 */
export function newEventsSince(
  eventTimestamps: string[],
  lastEventTs: string | undefined,
): number {
  if (lastEventTs === undefined) return eventTimestamps.length;
  const cutoff = Date.parse(lastEventTs);
  if (Number.isNaN(cutoff)) return eventTimestamps.length;
  let count = 0;
  for (const ts of eventTimestamps) {
    const t = Date.parse(ts);
    if (Number.isNaN(t) || t > cutoff) count++;
  }
  return count;
}

/** The newest event timestamp (by instant), or undefined for an empty log. */
export function newestEventTs(eventTimestamps: string[]): string | undefined {
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const ts of eventTimestamps) {
    const t = Date.parse(ts);
    // Parseable + later wins; an unparseable ts never displaces a real one.
    if (!Number.isNaN(t) && t > bestMs) {
      bestMs = t;
      best = ts;
    }
  }
  return best;
}

export interface VerifyInput {
  /** Timestamps of ALL feedback events (the log's `ts` field), any order. */
  eventTimestamps: string[];
  /** The cursor as of the last verified distill. */
  cursor: DistillCursor;
  /** The [learned] fingerprint of PREFERENCES.md AFTER the agent's distill. */
  learnedFingerprintAfter: string;
  /**
   * Did the agent explicitly log a "no change warranted" decision this run?
   * (e.g. a distill-log line the recipe scans for). An explicit no-op with
   * pending events is a VALID distill — but ONLY when the deterministic
   * aggregate corroborates it (see `aggregateBelowThreshold`). The agent grades
   * its own homework with this phrase, so the phrase alone can NOT clear a
   * skip; it must agree with the math.
   */
  explicitNoChangeLogged: boolean;
  /**
   * DETERMINISTIC corroboration of a no-change claim (finding B / MEDIUM fix).
   * True iff the strongest grouping among the PENDING (un-distilled) events
   * carries FEWER than the ≥2-signal generalization bar — i.e. no preference
   * could legitimately have been written, so "no change warranted" is the
   * correct verdict, not a lazy/hallucinated skip. Computed by the CLI from the
   * same `summarize-events` aggregate the agent reads (not from the agent's
   * free text). When the aggregate DOES clear the bar, a free-text "no change"
   * claim is NOT trusted — a real [learned] delta is required.
   */
  aggregateBelowThreshold: boolean;
}

/** The ≥2-consistent-signals generalization bar (distill-preferences SKILL §3). */
export const SIGNAL_THRESHOLD = 2;

export interface VerifyResult {
  /**
   * True when the distill was SKIPPED despite pending events (no [learned]
   * change AND no explicit no-change log). The recipe records this as
   * distill_skipped=true in the run-log instead of silently passing.
   */
  distillSkipped: boolean;
  /** New events since the cursor (drives the decision + the log detail). */
  pendingEvents: number;
  /** Did the [learned] fingerprint change vs the cursor this run? */
  learnedChanged: boolean;
  /** Human-readable reason for the run-log. NEVER generation content. */
  detail: string;
  /**
   * The cursor to PERSIST. It advances (consuming the pending events + recording
   * the new fingerprint) ONLY when the distill is verified — i.e. NOT skipped.
   * On a flagged skip the cursor is returned UNCHANGED so the pending events
   * remain pending for the next run to act on.
   */
  nextCursor: DistillCursor;
}

/**
 * The deterministic verification (finding B). See the module header for the
 * decision table. Pure: the CLI feeds it the inputs and persists `nextCursor`.
 */
export function verifyDistill(input: VerifyInput, runId: string): VerifyResult {
  const {
    eventTimestamps,
    cursor,
    learnedFingerprintAfter,
    explicitNoChangeLogged,
    aggregateBelowThreshold,
  } = input;
  const pendingEvents = newEventsSince(eventTimestamps, cursor.last_event_ts);
  const learnedChanged = learnedFingerprintAfter !== (cursor.learned_fingerprint ?? "");
  const newest = newestEventTs(eventTimestamps);

  // No pending events → nothing to distill. PASS; refresh the fingerprint so a
  // later [learned] edit that happens with no new events doesn't read as stale.
  if (pendingEvents === 0) {
    return {
      distillSkipped: false,
      pendingEvents,
      learnedChanged,
      detail: "no new feedback events since last distill — nothing to act on",
      nextCursor: advance(cursor, newest, learnedFingerprintAfter, runId),
    };
  }

  // A real [learned] delta is always a verified distill — the agent acted.
  if (learnedChanged) {
    return {
      distillSkipped: false,
      pendingEvents,
      learnedChanged: true,
      detail: `distill verified: ${pendingEvents} pending event(s) → [learned] lines changed`,
      nextCursor: advance(cursor, newest, learnedFingerprintAfter, runId),
    };
  }

  // No [learned] change. A "no change warranted" CLAIM is only honored when the
  // DETERMINISTIC aggregate agrees the pending events can't clear the ≥2-signal
  // bar (MEDIUM fix): the agent can't grade its own homework with a free-text
  // phrase. Phrase + math-agree → VALID no-op, advance the cursor.
  if (explicitNoChangeLogged && aggregateBelowThreshold) {
    return {
      distillSkipped: false,
      pendingEvents,
      learnedChanged: false,
      detail:
        `distill verified: ${pendingEvents} pending event(s) → agent logged "no change ` +
        `warranted" AND the aggregate confirms no grouping reaches the ≥${SIGNAL_THRESHOLD}-signal bar`,
      nextCursor: advance(cursor, newest, learnedFingerprintAfter, runId),
    };
  }

  // A claimed no-op that the math CONTRADICTS — the aggregate shows a grouping
  // that clears the ≥2-signal bar, yet [learned] is unchanged. This is exactly
  // the foolable case: the agent wrote the magic phrase but a real preference
  // was distillable and went unwritten. Flag it; do NOT burn the backlog.
  if (explicitNoChangeLogged && !aggregateBelowThreshold) {
    return {
      distillSkipped: true,
      pendingEvents,
      learnedChanged: false,
      detail:
        `distill SKIPPED: ${pendingEvents} pending event(s) and a "no change warranted" ` +
        `claim, but the aggregate shows a grouping at/above the ≥${SIGNAL_THRESHOLD}-signal ` +
        `bar with NO [learned] change — claimed no-op CONTRADICTED by the math, not trusted`,
      nextCursor: cursor,
    };
  }

  // Pending events AND neither a [learned] change NOR an explicit claim → a
  // SILENT skip. Flag it; cursor UNCHANGED so the pending events stay pending
  // for a real distill next run.
  return {
    distillSkipped: true,
    pendingEvents,
    learnedChanged: false,
    detail:
      `distill SKIPPED: ${pendingEvents} pending feedback event(s) but no [learned] ` +
      `change and no explicit "no change warranted" log — feed did not learn this run`,
    nextCursor: cursor,
  };
}

/**
 * DETERMINISTIC ≥2-signal-bar check over the PENDING events (finding B / MEDIUM
 * fix). Given the per-grouping generalizable-signal counts (e.g. from
 * `summarize-events` by_artifact / by_tag / by_type), return true iff EVERY
 * grouping carries fewer than the ≥2 bar — i.e. no preference could legitimately
 * have been distilled, so a "no change warranted" claim is corroborated. An
 * empty list (no pending generalizable signal at all) is below the bar.
 *
 * "Generalizable signal" excludes nothing here — the caller decides which
 * action counts feed in (we treat `save`-only utility separately upstream). This
 * function is the pure max-vs-threshold comparison; it does NOT read the agent's
 * prose.
 */
export function aggregateBelowThreshold(groupSignalCounts: number[]): boolean {
  let max = 0;
  for (const n of groupSignalCounts) if (n > max) max = n;
  return max < SIGNAL_THRESHOLD;
}

/** Build the advanced cursor (consume up to `newest`, record the fingerprint). */
function advance(
  prev: DistillCursor,
  newest: string | undefined,
  fingerprint: string,
  runId: string,
): DistillCursor {
  return {
    version: DISTILL_CURSOR_VERSION,
    // Keep the prior ts if the log somehow had no parseable newest (don't go
    // backwards); otherwise move the cursor to the newest consumed event.
    last_event_ts: newest ?? prev.last_event_ts,
    learned_fingerprint: fingerprint,
    last_run_id: runId,
    updated_at: new Date().toISOString(),
  };
}
