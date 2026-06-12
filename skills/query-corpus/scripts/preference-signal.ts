// preference-signal.ts — DETERMINISTIC selection backpressure (spec phase 2A).
//
// PREFERENCES.md is BACKPRESSURE: a control valve that steers what the engine
// SELECTS from the corpus, not just what it generates. This module is the
// model-free half of that. It parses the `[learned]` preference bullets into a
// deterministic PreferenceSignal (loved keywords + lead-types, and disliked
// keywords/topics), and scores a candidate index record against it so the
// feed-run recipe can BIAS the recency-pool ranking toward what Hunter has
// reacted well to — and away from what he's marked `less` / `already_knew`.
//
// JUDGMENT-VS-PLUMBING (NON-NEGOTIABLE): NO model calls here, ever. The parse is
// a regex/keyword extraction; the score is a transparent additive tally. The
// agent never enters this path — it's pure ranking plumbing, like the deep-dive
// novelty proxy in feed-run-lib.ts.
//
// THE ANTI-FILTER-BUBBLE SPLIT (critical, documented here and in feed-run):
//   - The RECENCY pool ranking IS preference-weighted (this module). Recency is
//     "what's new" — biasing it toward Hunter's tastes shapes the daily feed
//     toward him over time.
//   - The ROTATING DEEP-DIVE cursor stays preference-AGNOSTIC. It is the
//     DISCOVERY channel for asymmetric knowledge Hunter doesn't yet know he
//     wants. If we preference-weighted it too, the feed would collapse into a
//     filter bubble that only ever echoes existing tastes. So this module is
//     deliberately NOT wired into rankDeepDiveCandidates / the cursor — the
//     exploration reserve is preserved by construction.

import type { IndexRecord } from "../../index-corpus/scripts/corpus-index.ts";
import { STOPWORDS, TERM_RE } from "../../_shared/lib/stopwords.ts";

/** The reserved agent-owned prefix (mirrors preferences-guard-lib.ts). */
const LEARNED_PREFIX = "- [learned]";

/**
 * A parsed, deterministic preference signal derived from PREFERENCES.md's
 * `[learned]` bullets. Keywords are lowercased single tokens harvested from the
 * preference TEXT (stopword-filtered); lead-type phrases are multi-word handles
 * we match against a record's title/entities/terms.
 */
export interface PreferenceSignal {
  /** Loved keywords (from Topics/Style/Formats "more/promote/keep" bullets). */
  loved: Set<string>;
  /** Disliked keywords (from Novelty-bar / "less/skip/already_knew" bullets). */
  disliked: Set<string>;
  /** Per-keyword weight: a keyword cited in more bullets weighs more. */
  weights: Map<string, number>;
  /** The raw learned bullets we parsed, partitioned, for transparent logging. */
  lovedBullets: string[];
  dislikedBullets: string[];
}

/**
 * Markdown section headers in PREFERENCES.md and their default polarity. Topics,
 * Formats, Style, Cadence are LOVE channels (the things Hunter wants more of);
 * "Novelty bar" is the DISLIKE channel (what's below the bar — already known).
 * A bullet's wording can flip its polarity regardless of section (a `less` in
 * Topics is a dislike), handled in `bulletPolarity`.
 */
const LOVE_SECTIONS = new Set(["topics", "formats", "style", "cadence"]);
const DISLIKE_SECTIONS = new Set(["novelty bar"]);

/** Words in a learned bullet that signal a NEGATIVE preference (override section). */
const DISLIKE_MARKERS = [
  "less ",
  "skip ",
  "avoid ",
  "already_knew",
  "already knew",
  "below the novelty bar",
  "table stakes",
  "too basic",
  "noise",
];
/** Words that signal a POSITIVE preference (override a dislike section). */
const LOVE_MARKERS = ["more ", "promote", "keep producing", "earn deeper", "landing", "lean in"];

/**
 * Strip a bullet down to its PREFERENCE TEXT — drop the `- [learned]` prefix and
 * the trailing parenthetical evidence `(... Jun 2026)`, which is metadata, not
 * subject matter. Keeps the human-readable claim we harvest keywords from.
 */
export function bulletText(line: string): string {
  let t = line.trim();
  if (t.startsWith(LEARNED_PREFIX)) t = t.slice(LEARNED_PREFIX.length).trim();
  // Drop the last parenthetical group (the evidence citation) if present.
  t = t.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return t;
}

/** Decide a bullet's polarity: explicit markers win, else the section default. */
function bulletPolarity(text: string, section: string): "love" | "dislike" {
  const low = text.toLowerCase();
  if (DISLIKE_MARKERS.some((m) => low.includes(m))) return "dislike";
  if (LOVE_MARKERS.some((m) => low.includes(m))) return "love";
  if (DISLIKE_SECTIONS.has(section)) return "dislike";
  if (LOVE_SECTIONS.has(section)) return "love";
  return "love"; // default: a learned bullet with no markers in an unknown section is aspirational
}

/**
 * Preference-PROSE words — the meta-vocabulary the distill skill uses to PHRASE
 * a preference, not the SUBJECT MATTER it's about. These recur across bullets
 * ("lead with …", "in their own voice", "expand into deeper pieces", "no one
 * echoes") and would otherwise create weak +1 matches on unrelated transcripts,
 * diluting the steer. Excluded so the signal keys on the substantive topic
 * keywords (the hyphenated handles + domain nouns), not the framing verbs.
 * Polarity markers (more/less/skip/keep/promote) are dropped here too.
 */
const PREFERENCE_PROSE = new Set([
  // polarity / framing markers
  "more", "less", "skip", "keep", "promote", "promotes", "promoted", "avoid",
  "producing", "landing", "earn", "earns", "lean", "prefer", "prefers",
  // the distill skill's own structural vocabulary for describing a preference
  "lead", "leads", "voice", "voices", "claim", "claims", "frame", "framing",
  "pieces", "piece", "deeper", "expand", "expanded", "echoes", "echo", "tagged",
  "card", "cards", "signal", "signals", "artifact", "artifacts", "topic",
  "topics", "format", "formats", "style", "anchor", "anchored", "corpus",
  "person", "person's", "own", "one's", "across", "than", "over", "them",
]);

/**
 * Harvest matchable keywords from a bullet's preference text: lowercased tokens
 * (incl. hyphenated handles like "single-voice-thesis" and "strategic-thesis"),
 * using the SAME 4+-char `TERM_RE` + `STOPWORDS` vocabulary the index extracts
 * its terms with (so preference keywords and index terms are drawn from one
 * vocabulary), minus the preference-PROSE meta-words above. The result is the
 * substantive subject matter we look for in a candidate record's
 * title / entities / terms.
 */
export function keywordsFrom(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TERM_RE)) {
    const w = m[0];
    if (STOPWORDS.has(w)) continue;
    if (PREFERENCE_PROSE.has(w)) continue;
    out.push(w);
  }
  return out;
}

/**
 * Parse PREFERENCES.md into a deterministic PreferenceSignal. Walks the file by
 * markdown section, reads ONLY `- [learned]` bullets (human lines are ignored
 * for the SIGNAL — they steer via the agent's judgment downstream, not the
 * deterministic ranker), partitions each into love/dislike by polarity, and
 * tallies per-keyword weights (a keyword appearing in N loved bullets gets
 * weight N). A keyword that is BOTH loved and disliked is dropped from both
 * (contradictory signal — stay neutral, let exploration handle it).
 */
export function parsePreferenceSignal(markdown: string): PreferenceSignal {
  const loved = new Map<string, number>();
  const disliked = new Map<string, number>();
  const lovedBullets: string[] = [];
  const dislikedBullets: string[] = [];

  let section = "";
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trimEnd();
    const header = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (header) {
      section = header[1]!.trim().toLowerCase();
      continue;
    }
    if (!line.trim().startsWith(LEARNED_PREFIX)) continue; // only agent-owned bullets feed the signal

    const text = bulletText(line);
    if (!text) continue;
    const polarity = bulletPolarity(text, section);
    const keywords = keywordsFrom(text);
    if (keywords.length === 0) continue;

    const bank = polarity === "love" ? loved : disliked;
    for (const kw of keywords) bank.set(kw, (bank.get(kw) ?? 0) + 1);
    (polarity === "love" ? lovedBullets : dislikedBullets).push(text);
  }

  // Contradiction guard: a keyword in BOTH banks is ambiguous — drop it from
  // both so it neither boosts nor penalizes (neutral, exploration decides).
  for (const kw of [...loved.keys()]) {
    if (disliked.has(kw)) {
      loved.delete(kw);
      disliked.delete(kw);
    }
  }

  const weights = new Map<string, number>();
  for (const [kw, n] of loved) weights.set(kw, n);
  for (const [kw, n] of disliked) weights.set(kw, n);

  return {
    loved: new Set(loved.keys()),
    disliked: new Set(disliked.keys()),
    weights,
    lovedBullets,
    dislikedBullets,
  };
}

/** A transparent, per-candidate explanation of how a preference score was built. */
export interface PreferenceScore {
  /** Net score: (+) loved-keyword hits − (−) disliked-keyword hits, weighted. */
  score: number;
  /** Loved keywords that hit this record, with where they matched. */
  lovedHits: { keyword: string; weight: number; where: string }[];
  /** Disliked keywords that hit this record (subtract from score). */
  dislikedHits: { keyword: string; weight: number; where: string }[];
}

/**
 * Score one index record against the preference signal — DETERMINISTIC and
 * TRANSPARENT. We match loved/disliked keywords against the record's title,
 * entities, and terms (all lowercased). Each loved hit ADDS its weight; each
 * disliked hit SUBTRACTS its weight. A keyword is counted once per record (its
 * presence is the signal, not how many fields it lands in), and the FIELD it
 * matched is recorded so the recipe can log WHY a candidate ranked where it did.
 *
 * No transcript re-read — only the index record's already-extracted
 * entities/terms/title. (Mirrors rankDeepDiveCandidates: index-only.)
 */
export function scorePreferenceMatch(
  record: IndexRecord,
  signal: PreferenceSignal,
): PreferenceScore {
  // Build a lowercased haystack map: token → field it came from (first wins for
  // the "where" label). Title contributes its individual words too, so a
  // multi-word title still matches single-keyword preferences.
  const fields: { label: string; values: string[] }[] = [
    { label: "title", values: titleTokens(record.title) },
    { label: "entity", values: record.entities.map((e) => e.toLowerCase()) },
    { label: "term", values: record.terms.map((t) => t.toLowerCase()) },
  ];
  const where = new Map<string, string>();
  for (const f of fields) {
    for (const v of f.values) {
      // index whole-value AND its constituent words (so "single-voice-thesis"
      // and "strategic" both resolve). 4+ chars matches the keyword vocabulary
      // (TERM_RE) so a record word can't be shorter than any harvested keyword.
      for (const tok of [v, ...v.split(/[\s/_-]+/)]) {
        if (tok.length >= 4 && !where.has(tok)) where.set(tok, `${f.label}:${v}`);
      }
    }
  }

  const lovedHits: PreferenceScore["lovedHits"] = [];
  const dislikedHits: PreferenceScore["dislikedHits"] = [];
  for (const kw of signal.loved) {
    const w = where.get(kw);
    if (w !== undefined) lovedHits.push({ keyword: kw, weight: signal.weights.get(kw) ?? 1, where: w });
  }
  for (const kw of signal.disliked) {
    const w = where.get(kw);
    if (w !== undefined) dislikedHits.push({ keyword: kw, weight: signal.weights.get(kw) ?? 1, where: w });
  }

  const score =
    lovedHits.reduce((s, h) => s + h.weight, 0) -
    dislikedHits.reduce((s, h) => s + h.weight, 0);
  return { score, lovedHits, dislikedHits };
}

/** Tokenize a title into lowercased words + the whole lowercased title. */
function titleTokens(title: string | undefined): string[] {
  if (!title) return [];
  const low = title.toLowerCase();
  return [low, ...low.split(/[\s/_-]+/).filter((w) => w.length >= 3)];
}

/** True when the signal carries any usable preference (else ranking is a no-op). */
export function hasSignal(signal: PreferenceSignal): boolean {
  return signal.loved.size > 0 || signal.disliked.size > 0;
}
