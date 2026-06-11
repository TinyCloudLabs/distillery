// corpus-query.ts — deterministic retrieval over the corpus index (spec §3).
//
// Answers "which transcripts match this window/speaker/entity/term/source, and
// which have I already surfaced?" entirely over `index/corpus-index.json` — it
// NEVER re-reads transcript files. SURFACING ONLY: no model calls, no judgment;
// the agent reads the actual transcripts at the paths this returns and decides.
//
// The "already surfaced" mark is the UNION of two sources (spec §3):
//   1. the prior-artifact baseline (novelty.ts `priorArtifactIndex` over
//      artifacts/ — authoritative; survives even if the ledger is lost), and
//   2. the persisted surfaced ledger (surfaced-ledger.ts over index/surfaced.json).
//
// The CLI wrapper (query-corpus.ts) handles argv + env + format; everything
// testable lives here and is imported by both the CLI and the tests.

import { basename } from "node:path";
import type { CorpusIndex, IndexRecord } from "../../index-corpus/scripts/corpus-index.ts";
import { priorArtifactIndex, type PriorArtifactIndex } from "../../_shared/lib/novelty.ts";
import {
  ledgerEntriesByPath,
  type SurfacedEntry,
  type SurfacedLedger,
} from "./surfaced-ledger.ts";

/** The five filter dimensions (spec §3). All present filters AND together. */
export interface QueryFilters {
  /** Inclusive lower date bound (YYYY-MM-DD) against record.date. */
  since?: string;
  /** Inclusive upper date bound (YYYY-MM-DD) against record.date. */
  until?: string;
  /** Speaker who has at least one turn (case-insensitive). */
  speaker?: string;
  /** Entity present in record.entities (case-insensitive). */
  entity?: string;
  /** Domain term present in record.terms (case-insensitive). */
  term?: string;
  /** Source label: fireflies | gemini | soundcore | unknown. */
  source?: IndexRecord["source"];
}

export interface QueryOptions extends QueryFilters {
  /** Drop already-surfaced matches from the result. */
  unsurfacedOnly?: boolean;
  /** Cap the number of returned matches (after sorting). */
  limit?: number;
  /** Include flagged-empty records (default false — they're excluded). */
  includeEmpty?: boolean;
}

/** Which filter dimension a match satisfied (only present filters appear). */
export type MatchedDimension = "since" | "until" | "speaker" | "entity" | "term" | "source";

export interface QueryMatch {
  path: string;
  source: IndexRecord["source"];
  date?: string;
  title?: string;
  /** Which of the active filters this record hit (all of them, since AND). */
  matched_on: MatchedDimension[];
  /** Short evidence snippets from the index (quantity/entity/term contexts). */
  match_context: string[];
  surfaced: boolean;
  /** Provenance for the surfaced mark: artifact:… and/or ledger:… tags. */
  surfaced_by: string[];
}

export interface QueryResult {
  query: QueryFilters & { unsurfaced_only?: boolean; limit?: number };
  matches: QueryMatch[];
  counts: { total: number; surfaced: number; unsurfaced: number };
}

const MATCH_CONTEXT_LIMIT = 4;

const norm = (s: string): string => s.trim().toLowerCase();

/** Date-window compare on YYYY-MM-DD strings (lexicographic = chronological). */
function inDateWindow(date: string | undefined, since?: string, until?: string): boolean {
  if (since !== undefined) {
    if (date === undefined || date < since) return false;
  }
  if (until !== undefined) {
    if (date === undefined || date > until) return false;
  }
  return true;
}

/** Does this record satisfy ALL active filters? Returns the matched dims or null. */
function evaluate(record: IndexRecord, f: QueryFilters): MatchedDimension[] | null {
  const matched: MatchedDimension[] = [];

  if (f.since !== undefined || f.until !== undefined) {
    if (!inDateWindow(record.date, f.since, f.until)) return null;
    if (f.since !== undefined) matched.push("since");
    if (f.until !== undefined) matched.push("until");
  }
  if (f.speaker !== undefined) {
    const want = norm(f.speaker);
    if (!record.speakers.some((s) => norm(s) === want)) return null;
    matched.push("speaker");
  }
  if (f.entity !== undefined) {
    const want = norm(f.entity);
    if (!record.entities.some((e) => norm(e) === want)) return null;
    matched.push("entity");
  }
  if (f.term !== undefined) {
    const want = norm(f.term);
    if (!record.terms.some((t) => norm(t) === want)) return null;
    matched.push("term");
  }
  if (f.source !== undefined) {
    if (record.source !== f.source) return null;
    matched.push("source");
  }
  return matched;
}

/**
 * Pull a few human-readable evidence snippets for a match, all from the index
 * (no transcript re-read): the contexts of any quantity whose value/context
 * mentions a filtered entity/term, else the first couple of quantity contexts,
 * else the matched entity/term itself. Best-effort surfacing, capped.
 */
function matchContext(record: IndexRecord, f: QueryFilters): string[] {
  const out: string[] = [];
  const needles = [f.entity, f.term].filter((x): x is string => !!x).map(norm);

  if (needles.length > 0) {
    for (const q of record.quantities) {
      const hay = `${q.value} ${q.context}`.toLowerCase();
      if (needles.some((n) => hay.includes(n))) out.push(q.context);
    }
  }
  if (out.length === 0) {
    for (const q of record.quantities) out.push(q.context);
  }
  if (out.length === 0) {
    // No quantities — fall back to naming what matched so the line isn't empty.
    if (f.entity) {
      const hit = record.entities.find((e) => norm(e) === norm(f.entity!));
      if (hit) out.push(`entity: ${hit}`);
    }
    if (f.term) {
      const hit = record.terms.find((t) => norm(t) === norm(f.term!));
      if (hit) out.push(`term: ${hit}`);
    }
  }
  return [...new Set(out)].slice(0, MATCH_CONTEXT_LIMIT);
}

/**
 * Build the "already surfaced" join from the two sources (spec §3). Returns,
 * per transcript path, the provenance tags that mark it surfaced. A transcript
 * is surfaced iff it appears in ANY artifact's source_transcripts[] OR in the
 * ledger. Path matching is tolerant of absolute-vs-relative form (artifacts
 * store "the input paths as given") by also keying on basename.
 */
export function buildSurfacedJoin(
  baseline: PriorArtifactIndex,
  ledger: SurfacedLedger,
): (path: string) => string[] {
  // basename → provenance tags, and exact-path → tags. We consult both so an
  // artifact that recorded a relative path still marks the absolute index key.
  const byExact = new Map<string, string[]>();
  const byBase = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, tag: string): void => {
    const list = map.get(key) ?? [];
    if (!list.includes(tag)) list.push(tag);
    map.set(key, list);
  };

  for (const a of baseline.entries) {
    const tag = `artifact:${a.type}/${a.slug}`;
    for (const st of a.source_transcripts) {
      add(byExact, st, tag);
      add(byBase, basename(st), tag);
    }
  }
  for (const [path, entries] of ledgerEntriesByPath(ledger)) {
    for (const e of entries) {
      const tag = `ledger:${e.run_id}`;
      add(byExact, path, tag);
      add(byBase, basename(path), tag);
    }
  }

  return (path: string): string[] => {
    const tags = new Set<string>();
    for (const t of byExact.get(path) ?? []) tags.add(t);
    for (const t of byBase.get(basename(path)) ?? []) tags.add(t);
    return [...tags];
  };
}

/**
 * Run the query (pure over the supplied index + baseline + ledger). Records are
 * filtered (AND), empty records excluded by default, matches sorted by date
 * desc then path, optionally surfaced-filtered, then capped by limit. counts
 * reflect the post-limit returned matches.
 */
export function queryCorpus(
  index: CorpusIndex,
  baseline: PriorArtifactIndex,
  ledger: SurfacedLedger,
  opts: QueryOptions,
): QueryResult {
  const filters: QueryFilters = {
    since: opts.since,
    until: opts.until,
    speaker: opts.speaker,
    entity: opts.entity,
    term: opts.term,
    source: opts.source,
  };
  const surfacedFor = buildSurfacedJoin(baseline, ledger);

  let matches: QueryMatch[] = [];
  for (const record of index.transcripts) {
    if (record.empty && !opts.includeEmpty) continue;
    const matched = evaluate(record, filters);
    if (matched === null) continue;

    const surfaced_by = surfacedFor(record.path);
    const surfaced = surfaced_by.length > 0;
    if (opts.unsurfacedOnly && surfaced) continue;

    matches.push({
      path: record.path,
      source: record.source,
      date: record.date,
      title: record.title,
      matched_on: matched,
      match_context: matchContext(record, filters),
      surfaced,
      surfaced_by,
    });
  }

  // Newest first (undated last), then path for a stable order.
  matches.sort((a, b) => {
    const da = a.date ?? "";
    const db = b.date ?? "";
    if (da !== db) return da < db ? 1 : -1;
    return a.path.localeCompare(b.path);
  });

  if (opts.limit !== undefined && opts.limit >= 0) {
    matches = matches.slice(0, opts.limit);
  }

  const surfacedCount = matches.filter((m) => m.surfaced).length;
  return {
    query: {
      ...filters,
      unsurfaced_only: opts.unsurfacedOnly || undefined,
      limit: opts.limit,
    },
    matches,
    counts: {
      total: matches.length,
      surfaced: surfacedCount,
      unsurfaced: matches.length - surfacedCount,
    },
  };
}

/**
 * Convenience: load the baseline from artifactsDir (never throws — empty on a
 * missing dir) and run the query. The CLI uses this; tests can call queryCorpus
 * directly with a synthetic baseline.
 */
export async function queryCorpusWithArtifacts(
  index: CorpusIndex,
  artifactsDir: string,
  ledger: SurfacedLedger,
  opts: QueryOptions,
): Promise<QueryResult> {
  const baseline = await priorArtifactIndex(artifactsDir);
  return queryCorpus(index, baseline, ledger, opts);
}

/** Render a query result as a readable markdown report (spec §3, novelty-scan convention). */
export function renderQueryMarkdown(result: QueryResult): string {
  const out: string[] = [];
  out.push("# Corpus query");
  out.push("");
  const activeFilters = Object.entries(result.query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  out.push(`- filters: ${activeFilters.length ? activeFilters.join(", ") : "(none — whole index)"}`);
  out.push(`- matches: ${result.counts.total}`);
  out.push(`- surfaced: ${result.counts.surfaced} · unsurfaced: ${result.counts.unsurfaced}`);
  out.push("");
  out.push(
    "Paths only: this surfaces which transcripts match and whether you've" +
      " already shipped from them. Read the transcripts at these paths and judge.",
  );
  out.push("");
  out.push("## Matches (newest first)");
  if (result.matches.length === 0) {
    out.push("");
    out.push("- (none)");
  }
  for (const m of result.matches) {
    out.push("");
    const mark = m.surfaced ? "✓ surfaced" : "○ new";
    out.push(`### ${m.date ?? "(undated)"} — ${m.title ?? "(untitled)"}  [${mark}]`);
    out.push(`- path: \`${m.path}\``);
    out.push(`- source: ${m.source} · matched on: ${m.matched_on.join(", ") || "(no filters)"}`);
    if (m.surfaced_by.length > 0) out.push(`- surfaced by: ${m.surfaced_by.join(", ")}`);
    for (const c of m.match_context) out.push(`  - “…${c}…”`);
  }
  out.push("");
  return out.join("\n");
}
