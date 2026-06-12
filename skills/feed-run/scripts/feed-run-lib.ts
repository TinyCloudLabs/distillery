// feed-run-lib.ts — the testable plumbing for the feed-run recipe (spec §5).
//
// The recipe (Layer 2) is the agent's runbook: it sequences the deterministic
// skills (index-corpus, distill-preferences, query-corpus) and the existing
// generation skills, and PREPARES a run-brief that a generation agent consumes.
//
// CRITICAL judgment-vs-plumbing boundary (base SPEC): the recipe orchestrator
// shells the skill scripts and assembles a markdown brief — it makes NO model
// calls. Generation (extract-insights / write-article / make-podcast +
// illustrate-card) is AGENT judgment that happens AFTER the brief, driven by
// the generation skills' own SKILL.md + their baked-in novelty/critic. The
// orchestrator stops at the brief; `--dry-run` makes that explicit.
//
// Everything testable (step ordering, brief render, deep-dive ranking, the
// run-log shape, the --since resolution) lives here, imported by both the CLI
// (feed-run.ts) and the tests. No process side effects at import time.

import type { CorpusIndex, IndexRecord } from "../../index-corpus/scripts/corpus-index.ts";
import type { QueryMatch } from "../../query-corpus/scripts/corpus-query.ts";
import type { SurfacedMode } from "../../query-corpus/scripts/surfaced-ledger.ts";
import {
  scorePreferenceMatch,
  type PreferenceSignal,
} from "../../query-corpus/scripts/preference-signal.ts";

/** Run mode. `daily` is the heartbeat; `backfill` is the one-time excavation. */
export type RunMode = "daily" | "backfill";

/** The ordered pipeline steps (spec §5). Used for ordering + per-step logging. */
export const PIPELINE_STEPS = [
  "index",
  "distill",
  "query-recency",
  "query-deepdive",
  "brief",
  "generate",
  // PR #8 review: the loop is ENFORCED, not instruction-only. `guard` is the
  // deterministic human-line guard around the agent's distill write (finding
  // A); `verify-distill` is the post-run check that the distill actually
  // happened (finding B). Both run after the agent's distill task.
  "guard",
  "verify-distill",
  "save",
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/** Per-mode artifact caps (spec §5 params / §6 backfill). Backfill is bigger. */
export const MAX_ARTIFACTS_PER_RUN = 3;
export const MAX_ARTIFACTS_BACKFILL = 25; // TODO(PR6): full batched/checkpointed backfill.

export function capForMode(mode: RunMode): number {
  return mode === "backfill" ? MAX_ARTIFACTS_BACKFILL : MAX_ARTIFACTS_PER_RUN;
}

/** First-run recency lower bound when the ledger has no prior run (spec §5: 7 days). */
export const FIRST_RUN_RECENCY_DAYS = 7;

/** Default deep-dives per run (spec §5 / [D2]). */
export const DEEPDIVE_PER_RUN = 1;

/** A step's outcome in the structured run log (spec §5 degradation table / §7). */
export type StepStatus = "ok" | "skipped" | "degraded" | "failed" | "aborted";

export interface StepLog {
  step: PipelineStep;
  status: StepStatus;
  /** Human note (counts, why skipped/degraded). NEVER transcript content. */
  detail: string;
}

/** The structured per-run log appended to index/run-log.jsonl (spec §7). */
export interface RunLog {
  run_id: string;
  mode: RunMode;
  dry_run: boolean;
  since: string;
  cap: number;
  /** The ordered step outcomes. */
  steps: StepLog[];
  /** Paths selected by the recency window (after --unsurfaced-only). */
  recency_paths: string[];
  /** The single rotating deep-dive pick (path), if any. */
  deepdive_path?: string;
  /** Did the deep-dive cursor wrap this run? */
  deepdive_wrapped: boolean;
  /** Artifacts actually published (empty on dry-run / zero-artifact run). */
  artifacts_published: string[];
  /**
   * DETERMINISTIC distill verification (PR #8 finding B): true when the agent's
   * mandated distill was SKIPPED despite pending feedback events (no [learned]
   * change + no explicit "no change warranted" log). The run still completes,
   * but this flags that the feed did not learn — never a silent pass. Undefined
   * on dry-run / --no-generate (no agent distill ran to verify).
   */
  distill_skipped?: boolean;
  /** Count of pending feedback events at verification time (finding B). */
  distill_pending_events?: number;
  /**
   * DETERMINISTIC human-line guard outcome (PR #8 finding A): "ok" when every
   * human (non-[learned]) line survived the distill; "violation" when the agent
   * edited/removed/reordered a human line and PREFERENCES.md was RESTORED from
   * the pre-distill snapshot. Undefined when no agent distill ran (dry-run /
   * --no-generate).
   */
  guard?: "ok" | "violation";
  /** Final run status: completed (incl. zero-artifact), or aborted (index failed). */
  outcome: "completed" | "aborted";
  finished_at: string;
}

/**
 * Resolve the recency lower bound (spec §5 RECENCY_SINCE): an explicit --since
 * wins; else the last successful run's timestamp from the ledger; else
 * `now - FIRST_RUN_RECENCY_DAYS`. Returns a YYYY-MM-DD date (query-corpus
 * compares date strings). `lastRunIso` is the most recent ledger run_id.
 */
export function resolveSince(
  explicit: string | undefined,
  lastRunIso: string | undefined,
  now: Date,
): string {
  if (explicit) return toDate(explicit);
  if (lastRunIso) return toDate(lastRunIso);
  const d = new Date(now.getTime() - FIRST_RUN_RECENCY_DAYS * 24 * 60 * 60 * 1000);
  return toDate(d.toISOString());
}

/** Coerce an ISO timestamp / date-ish string to YYYY-MM-DD (the index's date form). */
export function toDate(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
  if (m) return m[1]!;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s.trim();
}

/**
 * Parse a relative `--since` window like "14d" / "3w" into a YYYY-MM-DD lower
 * bound relative to `now`. Returns undefined if `raw` is not a relative window
 * (the caller then treats it as an absolute date or falls through to the
 * ledger). Supports d (days) and w (weeks).
 */
export function parseRelativeSince(raw: string, now: Date): string | undefined {
  const m = /^(\d+)\s*([dw])$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unitDays = m[2]!.toLowerCase() === "w" ? 7 : 1;
  const d = new Date(now.getTime() - n * unitDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Deterministic deep-dive novelty proxy over the INDEX alone (spec §5): rank
 * never-recent, unsurfaced older transcripts by a proxy combining
 *   - single-voice entity count (record.entities.length — the index's
 *     single-voice-style extraction), and
 *   - drift-group membership: how many of this record's quantity VALUES recur
 *     in OTHER transcripts (a value seen across 2+ transcripts is a drift
 *     candidate per novelty.ts; membership count is a cheap index-only proxy).
 * NO model calls, NO transcript re-reads — purely over index records. Ties
 * break stably by date desc then path, matching query-corpus's order, so the
 * cursor advances over a stable list.
 */
export function rankDeepDiveCandidates(records: IndexRecord[]): IndexRecord[] {
  // Build the set of quantity values that appear in 2+ distinct transcripts.
  const valueDocs = new Map<string, Set<string>>();
  for (const r of records) {
    for (const q of r.quantities) {
      const key = q.value.trim().toLowerCase();
      if (!key) continue;
      const set = valueDocs.get(key) ?? new Set<string>();
      set.add(r.path);
      valueDocs.set(key, set);
    }
  }
  const driftValues = new Set(
    [...valueDocs.entries()].filter(([, docs]) => docs.size >= 2).map(([v]) => v),
  );

  const score = (r: IndexRecord): number => {
    const entityScore = r.entities.length;
    const driftScore = r.quantities.filter((q) =>
      driftValues.has(q.value.trim().toLowerCase()),
    ).length;
    return entityScore + driftScore;
  };

  return [...records].sort((a, b) => {
    const s = score(b) - score(a);
    if (s !== 0) return s;
    const da = a.date ?? "";
    const db = b.date ?? "";
    if (da !== db) return da < db ? 1 : -1;
    return a.path.localeCompare(b.path);
  });
}

/**
 * The deep-dive candidate ORDER the cursor walks (spec §5 intent: surface
 * high-novelty old threads, not merely the oldest). The recipe queries
 * `--unsurfaced-only` over ALL-BUT-RECENT transcripts, then ranks them with the
 * index-only novelty proxy (`rankDeepDiveCandidates`). This function takes that
 * ALREADY-RANKED list and returns its PATH order verbatim: NOVELTY is the
 * primary sort key, with date-desc then path as the deterministic tiebreak
 * (both already baked into `rankDeepDiveCandidates`). The cursor therefore
 * advances over the novelty order — the rank is no longer discarded.
 *
 * The ordering is still stable for the cursor: a transcript surfaced on a prior
 * lap (now filtered out by `--unsurfaced-only`) simply drops from the list and
 * the wrap lands on the next still-new thread.
 *
 * Pass the OUTPUT of `rankDeepDiveCandidates` here (not the raw candidate pool)
 * so the novelty order is preserved.
 */
export function orderedDeepDivePaths(rankedCandidates: IndexRecord[]): string[] {
  return rankedCandidates.map((r) => r.path);
}

// ---------------------------------------------------------------------------
// SELECTION BACKPRESSURE — preference-weighted recency ranking (spec phase 2A)
// ---------------------------------------------------------------------------
//
// PREFERENCES.md is a CONTROL VALVE on selection, not just generation. The
// recency pool (the daily "what's new" channel) is re-ranked so transcripts
// matching Hunter's [learned] loves rise and his [learned] dislikes sink —
// shaping the feed toward him over time. DETERMINISTIC, model-free (the score
// comes from preference-signal.ts, an index-only keyword tally).
//
// THE ANTI-FILTER-BUBBLE SPLIT (deliberate, load-bearing):
//   - RECENCY pool        → preference-WEIGHTED (here). It's the channel that
//                           should track Hunter's tastes.
//   - DEEP-DIVE cursor    → preference-AGNOSTIC (rankDeepDiveCandidates above is
//                           untouched). It's the DISCOVERY reserve for
//                           asymmetric knowledge he doesn't yet know he wants.
// Weighting both would collapse the feed into an echo chamber, so the deep-dive
// is intentionally NOT preference-weighted. This split is the exploration
// reserve, enforced by which function the signal is wired into.
//
// The ranking is STABLE and TRANSPARENT: preference score is the primary key,
// the original recency order (newest-first, the input order) is the tiebreak,
// and every candidate carries the loved/disliked keyword hits that moved it so
// the recipe can LOG why each ranked where it did.

/** One recency candidate after preference weighting — carries its rationale. */
export interface RankedRecencyMatch {
  match: QueryMatch;
  /** Net preference score (loved hits − disliked hits, weighted). 0 = neutral. */
  preferenceScore: number;
  /** Human-readable "why it moved" line (keyword hits), for transparent logging. */
  rationale: string;
}

/**
 * Re-rank the recency matches by preference score (PRIMARY), preserving the
 * incoming newest-first order as the deterministic tiebreak (SECONDARY). The
 * incoming `matches` are already query-corpus's newest-first output, so a neutral
 * signal (no loved/disliked hits anywhere) returns them UNCHANGED — backpressure
 * shapes, it never reorders without evidence.
 *
 * `lookup` maps a match path → its index record (preference scoring needs the
 * record's entities/terms/title). A path with no record scores neutral (0).
 *
 * NO model calls; pure over the supplied signal + records. Returns each match
 * wrapped with its score + a rationale string so feed-run.ts can log the
 * weighting transparently (the spec's "log why each candidate ranked where").
 */
export function rankRecencyByPreference(
  matches: QueryMatch[],
  signal: PreferenceSignal,
  lookup: (path: string) => IndexRecord | undefined,
): RankedRecencyMatch[] {
  const ranked = matches.map((match, originalIndex): RankedRecencyMatch & { originalIndex: number } => {
    const record = lookup(match.path);
    if (!record) {
      return { match, preferenceScore: 0, rationale: "neutral (no index record)", originalIndex };
    }
    const s = scorePreferenceMatch(record, signal);
    const loved = s.lovedHits.map((h) => `+${h.keyword}(${h.weight})@${h.where}`);
    const disliked = s.dislikedHits.map((h) => `-${h.keyword}(${h.weight})@${h.where}`);
    const parts = [...loved, ...disliked];
    const rationale =
      parts.length > 0
        ? `score ${s.score >= 0 ? "+" : ""}${s.score}: ${parts.join(", ")}`
        : "neutral (no preference keywords matched)";
    return { match, preferenceScore: s.score, rationale, originalIndex };
  });

  // Stable sort: higher preference score first; ties keep the original
  // (newest-first) recency order via the captured original index.
  ranked.sort((a, b) => b.preferenceScore - a.preferenceScore || a.originalIndex - b.originalIndex);
  return ranked.map(({ match, preferenceScore, rationale }) => ({ match, preferenceScore, rationale }));
}

export interface BriefInput {
  runId: string;
  mode: RunMode;
  since: string;
  cap: number;
  /** Recency-window matches (already --unsurfaced-only), newest first. */
  recency: QueryMatch[];
  /** The single rotating deep-dive pick, if eligible. */
  deepDive?: QueryMatch;
  deepDiveWrapped: boolean;
  /** The preferences panel the generation skills read (content, last-known-good). */
  preferences: string;
  /** Whether distill ran clean (false → degraded to existing PREFERENCES.md). */
  distillDegraded: boolean;
  /**
   * The deterministic feedback aggregation (summarize-events.ts --format md)
   * the agent applies distill-preferences judgment over as its FIRST task.
   * Undefined when distill degraded (no aggregation captured) — the brief then
   * tells the agent to run the aggregation itself before generating.
   */
  feedbackSummary?: string;
  /** Prior-artifact baseline summary line (counts only — no content). */
  baselineSummary: string;
}

/**
 * Render the run-brief (spec §5 GENERATE handoff). This is the deterministic
 * artifact the recipe produces and a generation agent/SKILL consumes — it lists
 * the queried transcripts (titles + paths ONLY, never content), the preferences,
 * the baseline, the cap, and the explicit generation instructions. The recipe
 * does NOT call an LLM; this brief is the handoff to the one that does.
 *
 * NEVER embed transcript content — only titles, dates, paths, and the
 * match_context snippets the index already surfaced (which are short evidence
 * lines, not transcript bodies). The generation agent reads the real files.
 */
export function renderBrief(b: BriefInput): string {
  const out: string[] = [];
  out.push(`# Feed-run brief — ${b.runId}`);
  out.push("");
  out.push(`- mode: **${b.mode}**`);
  out.push(`- recency since: ${b.since}`);
  out.push(`- MAX_ARTIFACTS_PER_RUN (cap): **${b.cap}**`);
  out.push(
    `- selected: ${b.recency.length} recency + ${b.deepDive ? 1 : 0} deep-dive` +
      ` (the agent picks the best ≤${b.cap})`,
  );
  out.push("");
  out.push("## How to use this brief (generation = your judgment)");
  out.push("");
  out.push(
    "This brief is plumbing. It tells you WHERE to look; you do the looking" +
      " and judging. For the transcripts below, run the existing generation" +
      " skills (extract-insights / write-article / make-podcast +" +
      " illustrate-card), each with its own novelty-scan + adversarial critic." +
      ` Publish at most **${b.cap}** survivors. Zero artifacts is a valid run` +
      " — quality beats quantity.",
  );
  out.push("");
  out.push("## GENERATION BACKPRESSURE — PREFERENCES.md STEERS what you make (MANDATORY)");
  out.push("");
  out.push(
    "PREFERENCES.md is a CONTROL VALVE on generation, not a passive journal." +
      " After Task #1 (re-read the freshly-distilled file), you MUST let its" +
      " `[learned]` lines steer topic, format, and depth — this is not" +
      " optional 'consideration', it is a directive:",
  );
  out.push("");
  out.push(
    "1. **BIAS toward `[learned]` loves.** Where a recency/deep-dive transcript" +
      " carries a topic/format/style a `[learned]` line favors, LEAN IN: pick" +
      " that angle, that format, that depth over an equally-novel alternative" +
      " the panel is silent on. The deterministic selection ranker already" +
      " floated preference-matching recency candidates up; your generation" +
      " choice must echo the same bias.",
  );
  out.push(
    "2. **Treat `promote` signals as a COMMISSION.** A `[learned]` line that a" +
      " card/topic/format earned a promote is a STANDING ORDER to expand that" +
      " thread into a DEEPER artifact when the material supports it — e.g. a" +
      " promoted insight-card's topic becomes an article or a micro-podcast" +
      " this run. Promotion is a queue of deeper-artifact commissions, not a" +
      " compliment.",
  );
  out.push(
    "3. **Treat `less` / `already_knew` signals as active SUPPRESSION.** A" +
      " `[learned]` line marking a lead/topic below the bar or unwanted means" +
      " do NOT generate that lead this run, even if a transcript surfaces it" +
      " — drop it and spend the cap elsewhere.",
  );
  out.push(
    "4. **The exploration reserve + novelty critic STILL bind.** Backpressure" +
      " shapes; it never overrides 'is this genuinely novel?'. The rotating" +
      " deep-dive thread is the discovery channel — generate from it on its" +
      " own merits even when it matches NO preference (that's how the feed" +
      " surfaces asymmetric knowledge Hunter doesn't yet know he wants). And a" +
      " preference-matching lead that fails the adversarial novelty critic is" +
      " still killed: preference never resurrects a non-novel angle.",
  );
  out.push("");
  out.push(
    "Worked example (tied to the current panel): a `[learned]` Style line favors" +
      " *single-voice strategic-thesis* cards and `[learned]` Formats says" +
      " single-voice-thesis cards EARN deeper artifacts (promote). So when a" +
      " transcript below contains one person's strategic thesis no one echoes," +
      " (a) prefer that lead over a generic multi-voice recap, and (b) if a prior" +
      " such card was promoted, expand THIS one into an article/podcast rather" +
      " than another card — unless the novelty critic kills it.",
  );
  out.push("");
  out.push("## TASK #1 (MANDATORY, BEFORE generating): close the preference loop");
  out.push("");
  out.push(
    "Reactions only become preferences if YOU write them. Before any" +
      " generation, run the **distill-preferences** skill" +
      " (`skills/distill-preferences/SKILL.md`):",
  );
  out.push("");
  out.push(
    "1. Read the **feedback summary** below (already aggregated for you by" +
      " `summarize-events.ts`) and open the artifacts it points at that carry" +
      " real signal (`less` / `wrong` / `promote` / any note).",
  );
  out.push(
    "2. Edit **ONLY `[learned]` bullets** in `PREFERENCES.md`. NEVER touch" +
      " human-authored (untagged) lines — they are authoritative; if a learned" +
      " candidate contradicts one, drop the candidate. Be conservative: require" +
      " **≥2 consistent signals** before a generalization, and cite the evidence" +
      " counts in each bullet, e.g. `(5× more + 3 save on founding-wedge card," +
      " Jun 2026)`. Zero updates is a valid result.",
  );
  out.push(
    "3. **Re-read the freshly-edited `PREFERENCES.md`** and generate against" +
      " THAT — not the snapshot embedded below (which is the pre-distill" +
      " last-known-good panel).",
  );
  out.push("");
  out.push(
    "This step is not skippable: it is the only thing that turns feedback into" +
      " learned preferences. Do it every run, even when it changes nothing.",
  );
  out.push("");
  out.push(
    "### Feedback summary (deterministic aggregation — your distill input)" +
      (b.distillDegraded ? " — DEGRADED" : ""),
  );
  out.push("");
  if (b.distillDegraded || b.feedbackSummary === undefined) {
    out.push(
      "- (aggregation unavailable this run — run" +
        " `bun skills/distill-preferences/scripts/summarize-events.ts --format md`" +
        " yourself before generating, then apply the judgment above.)",
    );
  } else {
    out.push("```md");
    out.push(b.feedbackSummary.trimEnd());
    out.push("```");
  }
  out.push("");
  out.push("## Preferences panel (PRE-distill snapshot — re-read the file after Task #1)" + (b.distillDegraded ? " (last-known-good — distill degraded)" : ""));
  out.push("");
  out.push("```md");
  out.push(b.preferences.trimEnd());
  out.push("```");
  out.push("");
  out.push("## Prior-artifact baseline");
  out.push("");
  out.push(`- ${b.baselineSummary}`);
  out.push(
    "- the surfaced join already dropped anything in this baseline from the" +
      " selection below; the novelty critic still guards against re-angling.",
  );
  out.push("");
  out.push(`## Recency window (since ${b.since}) — ${b.recency.length} transcript(s)`);
  if (b.recency.length === 0) {
    out.push("");
    out.push("- (none — recency window empty; this is a deep-dive-only run)");
  }
  for (const m of b.recency) {
    out.push("");
    out.push(`### ${m.date ?? "(undated)"} — ${m.title ?? "(untitled)"}`);
    out.push(`- path: \`${m.path}\``);
    out.push(`- source: ${m.source}`);
    for (const c of m.match_context) out.push(`  - “…${c}…”`);
  }
  out.push("");
  out.push("## Rotating deep-dive (one older never-surfaced thread)");
  if (!b.deepDive) {
    out.push("");
    out.push("- (none eligible — all older threads already surfaced; recency-only run)");
  } else {
    out.push("");
    out.push(
      `### ${b.deepDive.date ?? "(undated)"} — ${b.deepDive.title ?? "(untitled)"}` +
        (b.deepDiveWrapped ? "  [cursor wrapped]" : ""),
    );
    out.push(`- path: \`${b.deepDive.path}\``);
    out.push(`- source: ${b.deepDive.source}`);
    for (const c of b.deepDive.match_context) out.push(`  - “…${c}…”`);
  }
  out.push("");
  out.push("## After you generate");
  out.push("");
  out.push(
    "- save survivors with `save.ts` (auto-publish straight to artifacts/).",
  );
  out.push(
    "- append each examined transcript to `index/surfaced.json` (path," +
      " topic_keys, outcome shipped|examined-no-ship, mode). The deep-dive" +
      " cursor is ALREADY advanced + persisted by the orchestrator — do NOT" +
      " reconstruct it; just append the surfaced entries.",
  );
  out.push("");
  return out.join("\n");
}

/** A one-line summary appended to index/run-log.jsonl (spec §7 wrapper line). */
export function summarizeRun(log: RunLog): string {
  return (
    `${log.run_id} mode=${log.mode}${log.dry_run ? " dry-run" : ""} ` +
    `since=${log.since} cap=${log.cap} ` +
    `recency=${log.recency_paths.length} ` +
    `deepdive=${log.deepdive_path ? "1" : "0"}${log.deepdive_wrapped ? "(wrapped)" : ""} ` +
    `published=${log.artifacts_published.length}` +
    (log.guard ? ` guard=${log.guard}` : "") +
    (log.distill_skipped ? " distill_skipped=true" : "") +
    ` outcome=${log.outcome}`
  );
}

/**
 * The topic-key list the recipe attaches to a ledger entry for a transcript
 * (spec §3 ledger schema). Deterministic: derived from the index record's top
 * entities/terms (lowercased, joined). NOT judgment — just a stable key so the
 * deep-dive/backfill don't re-chew the same thread.
 */
export function topicKeysFor(record: IndexRecord, max = 3): string[] {
  const parts = [...record.entities, ...record.terms]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, max);
  return parts.length ? [parts.join(",")] : [];
}

/** Map a query mode label to the ledger's SurfacedMode (spec §3/§5). */
export function ledgerMode(mode: RunMode, kind: "recency" | "deepdive"): SurfacedMode {
  if (mode === "backfill") return "backfill";
  return kind === "deepdive" ? "deepdive" : "recency";
}

/** Older-than-recency records, the deep-dive candidate POOL (before unsurfaced filter). */
export function olderThan(index: CorpusIndex, since: string): IndexRecord[] {
  return index.transcripts.filter((r) => !r.empty && (r.date ?? "") < since);
}
