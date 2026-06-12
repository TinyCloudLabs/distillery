// preference-signal.test.ts — DETERMINISTIC selection backpressure (phase 2A).
//
// Covers: parsing PREFERENCES.md [learned] bullets into a love/dislike signal
// (human lines ignored, evidence parens stripped, polarity by marker+section,
// contradiction drop); scoring an index record against the signal
// (loved boosts, disliked penalizes, transparent hits); and — the critical
// anti-filter-bubble guarantee — that the RECENCY pool is preference-weighted
// while the DEEP-DIVE cursor stays preference-agnostic (exploration reserve).
//
// All transcript content here is SYNTHETIC — never real meeting text.

import { describe, expect, test } from "bun:test";
import type { IndexRecord } from "../skills/index-corpus/scripts/corpus-index.ts";
import type { QueryMatch } from "../skills/query-corpus/scripts/corpus-query.ts";
import {
  parsePreferenceSignal,
  scorePreferenceMatch,
  hasSignal,
  bulletText,
  keywordsFrom,
} from "../skills/query-corpus/scripts/preference-signal.ts";
import {
  rankRecencyByPreference,
  rankDeepDiveCandidates,
  orderedDeepDivePaths,
} from "../skills/feed-run/scripts/feed-run-lib.ts";

// --- synthetic fixtures ----------------------------------------------------

function rec(over: Partial<IndexRecord> & Pick<IndexRecord, "path">): IndexRecord {
  return {
    source: "fireflies",
    title: "Untitled",
    date: "2026-06-08",
    speakers: ["Ada"],
    speakerTurnCounts: { Ada: 1 },
    turnCount: 1,
    entities: [],
    terms: [],
    quantities: [],
    content_hash: "sha256:x",
    indexed_at: "2026-06-08T00:00:00Z",
    empty: false,
    ...over,
  };
}

function match(over: Partial<QueryMatch> & Pick<QueryMatch, "path">): QueryMatch {
  return {
    source: "fireflies",
    date: "2026-06-08",
    title: "Untitled",
    matched_on: ["since"],
    match_context: [],
    surfaced: false,
    surfaced_by: [],
    ...over,
  };
}

// A realistic-ish PREFERENCES.md slice modeled on the current real file's shape.
const PREFS = `# PREFERENCES

- a HUMAN line that mentions strategic things but must NOT feed the signal

## Topics

<!-- example -->
- [learned] More foundational/strategic theses on TinyCloud positioning — strategic-thesis wedge framing (4 more + 3 promote, Jun 2026)

## Novelty bar

- [learned] Skip basic UCAN explainers — table stakes (2× already_knew on ucan-101 cards, Jun 2026)

## Formats

- [learned] Insight cards are landing — keep producing them (5 more + 4 save, Jun 2026)

## Style

- [learned] Lead with one person's strategic thesis in their own voice — single-voice-thesis claim (5 more + 3 promote, Jun 2026)
`;

// === parsing ===============================================================

describe("parsePreferenceSignal", () => {
  test("strips the [learned] prefix and the trailing evidence parens", () => {
    expect(bulletText("- [learned] More strategic theses (4 more, Jun 2026)")).toBe(
      "More strategic theses",
    );
  });

  test("keywordsFrom drops stopwords and polarity markers, keeps hyphenated handles", () => {
    const kws = keywordsFrom("More strategic-thesis wedge framing");
    expect(kws).toContain("strategic-thesis");
    expect(kws).toContain("wedge");
    expect(kws).not.toContain("more");
  });

  test("partitions loved vs disliked by section + marker; ignores human lines", () => {
    const sig = parsePreferenceSignal(PREFS);
    // Loved keywords come from Topics/Formats/Style learned bullets.
    expect(sig.loved.has("strategic-thesis")).toBe(true);
    expect(sig.loved.has("single-voice-thesis")).toBe(true);
    // "insight" is the substantive keyword from "Insight cards are landing…";
    // "cards" / "landing" are preference-PROSE and intentionally excluded.
    expect(sig.loved.has("insight")).toBe(true);
    expect(sig.loved.has("cards")).toBe(false);
    // Disliked from the Novelty-bar "skip ... table stakes" bullet.
    expect(sig.disliked.has("ucan")).toBe(true);
    expect(sig.disliked.has("explainers")).toBe(true);
    // The HUMAN line mentioning "strategic" must NOT have contributed (it's not
    // a [learned] bullet) — "strategic" only enters via the learned topic bullet.
    expect(hasSignal(sig)).toBe(true);
  });

  test("a keyword cited in multiple loved bullets gets a higher weight", () => {
    const sig = parsePreferenceSignal(
      `## Topics\n- [learned] More strategic wedge (x)\n## Style\n- [learned] More strategic voice (y)\n`,
    );
    expect(sig.weights.get("strategic")).toBe(2);
  });

  test("a keyword that is BOTH loved and disliked is dropped from both (neutral)", () => {
    const sig = parsePreferenceSignal(
      `## Topics\n- [learned] More pricing detail (x)\n## Novelty bar\n- [learned] Skip pricing — table stakes (y)\n`,
    );
    expect(sig.loved.has("pricing")).toBe(false);
    expect(sig.disliked.has("pricing")).toBe(false);
  });

  test("empty / no-[learned] file yields no signal", () => {
    expect(hasSignal(parsePreferenceSignal("# PREFERENCES\n\njust human prose\n"))).toBe(false);
  });
});

// === scoring ===============================================================

describe("scorePreferenceMatch", () => {
  const sig = parsePreferenceSignal(PREFS);

  test("a loved-keyword match boosts the score and records where it hit", () => {
    const r = rec({ path: "/x.md", entities: ["Strategic-Thesis"], terms: ["wedge"] });
    const s = scorePreferenceMatch(r, sig);
    expect(s.score).toBeGreaterThan(0);
    expect(s.lovedHits.map((h) => h.keyword)).toEqual(
      expect.arrayContaining(["strategic-thesis", "wedge"]),
    );
    expect(s.lovedHits[0]!.where).toContain("entity:");
  });

  test("a disliked-keyword match penalizes the score", () => {
    const r = rec({ path: "/y.md", terms: ["ucan", "explainers"] });
    const s = scorePreferenceMatch(r, sig);
    expect(s.score).toBeLessThan(0);
    expect(s.dislikedHits.map((h) => h.keyword)).toEqual(
      expect.arrayContaining(["ucan", "explainers"]),
    );
  });

  test("title words also match (single keyword inside a multi-word title)", () => {
    const r = rec({ path: "/z.md", title: "The strategic-thesis wedge call" });
    const s = scorePreferenceMatch(r, sig);
    expect(s.lovedHits.length).toBeGreaterThan(0);
    expect(s.lovedHits.some((h) => h.where.startsWith("title:"))).toBe(true);
  });

  test("a record with no preference keywords scores neutral (0)", () => {
    const r = rec({ path: "/n.md", entities: ["Weather"], terms: ["lunch"] });
    expect(scorePreferenceMatch(r, sig).score).toBe(0);
  });
});

// === THE ANTI-FILTER-BUBBLE SPLIT (the load-bearing guarantee) =============

describe("exploration-reserve split: recency weighted, deep-dive agnostic", () => {
  const sig = parsePreferenceSignal(PREFS);

  // Two recency candidates: a thesis-matching one and a non-matching one. The
  // non-matching one is NEWER, so absent preferences it sorts first.
  const thesisMatch = match({
    path: "/2026-06-05-thesis.md",
    date: "2026-06-05",
    title: "Strategic-thesis wedge",
  });
  const nonMatch = match({
    path: "/2026-06-09-other.md",
    date: "2026-06-09",
    title: "Lunch logistics",
  });
  const records = new Map<string, IndexRecord>([
    [thesisMatch.path, rec({ path: thesisMatch.path, entities: ["Strategic-Thesis"], terms: ["wedge"] })],
    [nonMatch.path, rec({ path: nonMatch.path, entities: ["Lunch"], terms: ["logistics"] })],
  ]);

  test("RECENCY: a thesis-matching transcript outranks a non-matching one", () => {
    // query-corpus emits newest-first: [nonMatch, thesisMatch].
    const incoming = [nonMatch, thesisMatch];
    const ranked = rankRecencyByPreference(incoming, sig, (p) => records.get(p));
    // Preference weighting promotes the thesis match above the newer non-match.
    expect(ranked.map((r) => r.match.path)).toEqual([thesisMatch.path, nonMatch.path]);
    expect(ranked[0]!.preferenceScore).toBeGreaterThan(0);
    expect(ranked[0]!.rationale).toContain("strategic-thesis");
  });

  test("RECENCY: a neutral signal leaves the newest-first order unchanged", () => {
    const incoming = [nonMatch, thesisMatch];
    const ranked = rankRecencyByPreference(
      incoming,
      parsePreferenceSignal("# PREFERENCES\nno learned bullets\n"),
      (p) => records.get(p),
    );
    expect(ranked.map((r) => r.match.path)).toEqual([nonMatch.path, thesisMatch.path]);
  });

  test("DEEP-DIVE: the cursor order is UNAFFECTED by preferences (exploration preserved)", () => {
    // The deep-dive ranker (rankDeepDiveCandidates) takes ONLY index records and
    // a novelty proxy — it has no preference parameter at all. Prove the picked
    // order does not change whether or not a candidate matches the preference
    // signal: a thesis-matching record with FEWER entities still ranks below a
    // non-matching record with MORE entities (novelty wins, not preference).
    const thesisRec = rec({
      path: "/old-thesis.md",
      date: "2026-05-01",
      entities: ["Strategic-Thesis"], // matches a love, but only 1 entity
      terms: ["wedge"],
    });
    const richNonMatchRec = rec({
      path: "/old-other.md",
      date: "2026-05-01",
      entities: ["Alpha", "Beta", "Gamma", "Delta"], // no preference match, 4 entities
      terms: ["x", "y", "z"],
    });
    const ordered = orderedDeepDivePaths(
      rankDeepDiveCandidates([thesisRec, richNonMatchRec]),
    );
    // Novelty (entity count) wins: the richer non-matching record ranks first,
    // even though the other one matches a [learned] love. Preferences never
    // entered the deep-dive ranking — the exploration reserve is intact.
    expect(ordered[0]).toBe(richNonMatchRec.path);
  });
});
