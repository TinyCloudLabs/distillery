// novelty.ts — deterministic novelty-candidate analyzers for distillery.
//
// Mission: artifacts must surface TRULY NOVEL synthesis — things a listener
// who attended the source meetings could not have done in the room. These
// analyzers do the deterministic half of that hunt: they SURFACE candidates
// (quantified-claim drift, single-voice topics, the prior-artifact
// baseline); the agent reading a SKILL.md JUDGES whether a candidate is
// actually novel. No model calls here, ever.
//
// Three analyzers:
//   trackQuantities       quantified claims ($100K, 20%, "10 people",
//                         "by Friday") with context + provenance, grouped
//                         across transcripts by fuzzy topic key, ordered
//                         chronologically — drift candidates.
//   findSingleVoiceTopics terms/entities only ONE speaker ever uses —
//                         asymmetric-knowledge candidates, with an
//                         engagement signal per mention.
//   priorArtifactIndex    what previous artifacts already surfaced — the
//                         novelty BASELINE a new angle must beat.
//
// Extraction patterns were grounded against real Fireflies transcripts
// (spoken-money shapes like "$100k", "$50,000", "100 grand", "3 to 5
// million bucks"; "20%"; "by Friday"; "10 people") — but only synthetic
// fixtures appear in tests, never meeting content.

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Transcript } from "./transcript.ts";
import { STOPWORDS, TERM_RE } from "./stopwords.ts";

// ---------------------------------------------------------------------------
// Quantity tracking — drift candidates
// ---------------------------------------------------------------------------

export type QuantityKind = "money" | "percent" | "count" | "deadline";

export interface QuantityMention {
  /** Path of the transcript the mention came from. */
  transcript: string;
  /** Transcript-level date header when present (chronology anchor). */
  date?: string;
  speaker?: string;
  /** Turn timestamp as it appeared, e.g. "12:56" or "01:29:10". */
  timestamp?: string;
  /** Index into transcript.turns — exact provenance. */
  turnIndex: number;
  kind: QuantityKind;
  /** The matched text exactly as spoken, e.g. "$100k", "3 to 5 million". */
  value: string;
  /** ~6 words either side of the match, for the agent's read. */
  context: string;
  /** Stopword-filtered lowercased terms near the match (grouping key input). */
  topicTerms: string[];
}

export interface QuantityGroup {
  /** Context terms shared by every pairing that bound this group. */
  topicKey: string[];
  /** Distinct transcript paths, in chronological mention order. */
  transcripts: string[];
  /** Mentions in chronological order (transcript date → timestamp → turn). */
  mentions: QuantityMention[];
}

export interface QuantityTrack {
  /**
   * Groups whose mentions span 2+ transcripts — DRIFT CANDIDATES. The
   * script only lines the evidence up chronologically; whether
   * "$100K to close" → "eventually" is drift is the agent's judgment.
   */
  groups: QuantityGroup[];
  /** Notable mentions that didn't group across transcripts. */
  singles: QuantityMention[];
}

// Money, as actually spoken in meetings (grounded on real Fireflies corpus):
// "$100k" / "$100K" / "$50,000" / "$7.5 m(illion)" / "$2,600"
const MONEY_SYMBOL_RE =
  /\$\d[\d,]*(?:\.\d+)?(?:\s*(?:thousand|million|billion|[kKmMbB])\b)?/g;
// "5 million" / "3 to 5 million bucks" / "200 million of the billion tokens"
// / "100 grand" / "ten thousand dollars" (digit-led ranges + scale words)
const MONEY_SCALE_RE =
  /\b\d[\d,]*(?:\.\d+)?(?:\s+(?:to|or)\s+\d[\d,]*(?:\.\d+)?)?(?:\s+and\s+a\s+half)?\s+(?:grand|thousand|million|billion)\b(?:\s+(?:bucks|dollars))?/gi;
// spelled magnitude money heard in speech: "a hundred grand", "hundred K"
const MONEY_SPELLED_RE =
  /\b(?:a\s+)?(?:couple\s+)?(?:hundred|few)\s+(?:hundred\s+)?(?:grand|thousand|million|billion|[kK])\b/g;
// NB: no \b after "%" — % is a non-word char, so a trailing \b would require
// a following word char and silently kill every "20% " match.
const PERCENT_RE = /\b\d+(?:\.\d+)?\s*(?:%|percent\b)/gi;
// Counts with a unit noun ("10 people", "30 meetings", "24 months").
const COUNT_UNITS =
  "users?|customers?|people|persons?|meetings?|investors?|companies|engineers?|developers?|emails?|apps?|tokens?|transcripts?|episodes?|cards?|weeks?|days?|months?|years?|hours?|minutes?";
const COUNT_RE = new RegExp(String.raw`\b\d[\d,]*\s+(?:${COUNT_UNITS})\b`, "gi");
// Deadlines / commitments in time: "by Friday", "end of July", "before June",
// "by June 15", "next week", "Q3".
const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const DAYS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const DEADLINE_RE = new RegExp(
  String.raw`\b(?:(?:by|before|until|due)\s+(?:the\s+)?(?:end\s+of\s+)?(?:${MONTHS}|${DAYS}|next\s+(?:week|month|quarter|year)|Q[1-4])(?:\s+\d{1,2})?(?:,?\s+\d{4})?|end\s+of\s+(?:${MONTHS}|the\s+(?:month|quarter|year)|Q[1-4]))\b`,
  "g",
);

/** Word window sizes: display context vs. topic-term harvest. */
const CONTEXT_WORDS = 6;
const TOPIC_WORDS = 12;
/** Mentions group when (same kind and) they share at least this many terms. */
const MIN_SHARED_TOPIC_TERMS = 2;
/** Count-kind time units are too noisy to surface as notable singles. */
const TIME_UNIT_RE = /\b(?:weeks?|days?|months?|years?|hours?|minutes?)$/i;

interface RawMatch {
  kind: QuantityKind;
  value: string;
  start: number;
  end: number;
}

/** Extract quantity matches from one turn's text, de-overlapped by priority. */
export function extractQuantities(text: string): RawMatch[] {
  const candidates: RawMatch[] = [];
  const collect = (re: RegExp, kind: QuantityKind) => {
    for (const m of text.matchAll(re)) {
      candidates.push({ kind, value: m[0], start: m.index, end: m.index + m[0].length });
    }
  };
  // Priority order: money beats count ("5 million bucks" is money, not a
  // count of "bucks"); percent and deadline don't collide with the others.
  collect(MONEY_SYMBOL_RE, "money");
  collect(MONEY_SCALE_RE, "money");
  collect(MONEY_SPELLED_RE, "money");
  collect(PERCENT_RE, "percent");
  collect(DEADLINE_RE, "deadline");
  collect(COUNT_RE, "count");

  // De-overlap: earlier collectors win; among same collector, longer wins.
  const out: RawMatch[] = [];
  for (const c of candidates) {
    const clash = out.findIndex((o) => c.start < o.end && o.start < c.end);
    if (clash === -1) {
      out.push(c);
    } else if (
      out[clash]!.kind === c.kind &&
      c.end - c.start > out[clash]!.end - out[clash]!.start
    ) {
      out[clash] = c; // same kind, longer match (e.g. "3 to 5 million" over "5 million")
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function wordWindow(text: string, start: number, end: number, words: number): string {
  const before = text.slice(0, start).split(/\s+/).filter(Boolean).slice(-words);
  const after = text.slice(end).split(/\s+/).filter(Boolean).slice(0, words);
  return [...before, text.slice(start, end), ...after].join(" ");
}

function topicTermsFrom(window: string): string[] {
  const terms = new Set<string>();
  for (const m of window.toLowerCase().matchAll(TERM_RE)) {
    if (!STOPWORDS.has(m[0])) terms.add(m[0]);
  }
  return [...terms].sort();
}

function timestampSeconds(stamp?: string): number {
  if (!stamp) return -1;
  const parts = stamp.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return -1;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return -1;
}

function chronoCompare(a: QuantityMention, b: QuantityMention): number {
  const dateA = a.date ?? "";
  const dateB = b.date ?? "";
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  if (a.transcript !== b.transcript) return a.transcript < b.transcript ? -1 : 1;
  const ta = timestampSeconds(a.timestamp);
  const tb = timestampSeconds(b.timestamp);
  if (ta !== tb) return ta - tb;
  return a.turnIndex - b.turnIndex;
}

/**
 * Track quantified claims across a corpus. Extracts money / percent /
 * count-with-unit / deadline mentions from SPOKEN turns only (Fireflies'
 * AI-generated Summary and Action Items headers are not speech and are
 * excluded — same stance as verifyQuote), groups them across transcripts by
 * fuzzy topic key (same kind + >= 2 shared nearby non-stopword terms), and
 * orders every group chronologically. Groups spanning 2+ transcripts are the
 * drift candidates; the agent judges whether the delta is real drift.
 */
/**
 * Build the raw quantity mentions (money/percent/count/deadline with context +
 * provenance) for one transcript's spoken turns. Shared by `trackQuantities`
 * (cross-corpus clustering) and `index-corpus` (per-transcript records), so
 * the index and the scan extract the same quantities.
 */
export function collectQuantityMentions(t: Transcript): QuantityMention[] {
  const mentions: QuantityMention[] = [];
  for (const [turnIndex, turn] of t.turns.entries()) {
    for (const raw of extractQuantities(turn.text)) {
      mentions.push({
        transcript: t.path,
        date: t.date,
        speaker: turn.speaker,
        timestamp: turn.timestamp,
        turnIndex,
        kind: raw.kind,
        value: raw.value,
        context: wordWindow(turn.text, raw.start, raw.end, CONTEXT_WORDS),
        topicTerms: topicTermsFrom(wordWindow(turn.text, raw.start, raw.end, TOPIC_WORDS)),
      });
    }
  }
  return mentions;
}

export function trackQuantities(transcripts: Transcript[]): QuantityTrack {
  const mentions: QuantityMention[] = transcripts.flatMap(collectQuantityMentions);

  // Union-find clustering: same kind + >= MIN_SHARED_TOPIC_TERMS shared terms.
  const parent = mentions.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < mentions.length; i++) {
    for (let j = i + 1; j < mentions.length; j++) {
      if (mentions[i]!.kind !== mentions[j]!.kind) continue;
      const shared = mentions[i]!.topicTerms.filter((t) =>
        mentions[j]!.topicTerms.includes(t),
      );
      if (shared.length >= MIN_SHARED_TOPIC_TERMS) union(i, j);
    }
  }

  const clusters = new Map<number, QuantityMention[]>();
  mentions.forEach((m, i) => {
    const root = find(i);
    (clusters.get(root) ?? clusters.set(root, []).get(root)!).push(m);
  });

  const groups: QuantityGroup[] = [];
  const singles: QuantityMention[] = [];
  for (const cluster of clusters.values()) {
    cluster.sort(chronoCompare);
    const paths = [...new Set(cluster.map((m) => m.transcript))];
    if (paths.length >= 2) {
      // topicKey = terms shared by ALL mentions (the group's common thread);
      // fall back to terms shared by 2+ mentions when full intersection is empty.
      let key = cluster.reduce<string[]>(
        (acc, m) => acc.filter((t) => m.topicTerms.includes(t)),
        cluster[0]!.topicTerms,
      );
      if (key.length === 0) {
        const counts = new Map<string, number>();
        for (const m of cluster)
          for (const t of m.topicTerms) counts.set(t, (counts.get(t) ?? 0) + 1);
        key = [...counts.entries()].filter(([, n]) => n >= 2).map(([t]) => t).sort();
      }
      groups.push({ topicKey: key, transcripts: paths, mentions: cluster });
    } else {
      // Notable singles: money, percent, deadlines always; counts only with
      // non-time units ("30 minutes" is meeting noise, "10 people" isn't).
      for (const m of cluster) {
        if (m.kind === "count" && TIME_UNIT_RE.test(m.value)) continue;
        singles.push(m);
      }
    }
  }
  groups.sort(
    (a, b) =>
      b.transcripts.length - a.transcripts.length ||
      b.mentions.length - a.mentions.length ||
      (a.topicKey.join(",") < b.topicKey.join(",") ? -1 : 1),
  );
  singles.sort(chronoCompare);
  return { groups, singles };
}

// ---------------------------------------------------------------------------
// Single-voice topics — asymmetric-knowledge candidates
// ---------------------------------------------------------------------------

export interface SingleVoiceMention {
  transcript: string;
  date?: string;
  timestamp?: string;
  turnIndex: number;
  /** ~10 words either side of the term. */
  context: string;
  /**
   * Did any OTHER speaker give a substantive reply (>= 40 chars — more than
   * back-channel "Yeah.") within the next 3 turns? A heuristic engagement
   * signal: an un-engaged single-voice topic may be knowledge the room
   * didn't absorb; an engaged one may be knowledge they asked about.
   */
  engaged: boolean;
}

export interface SingleVoiceTopic {
  /** Normalized (lowercased) term key. */
  term: string;
  /** The term as it appeared most often (original casing). */
  display: string;
  /** The only speaker in the corpus who uses this term. */
  speaker: string;
  /** True for capitalized entities/phrases, false for lowercase domain words. */
  entity: boolean;
  transcripts: string[];
  mentionCount: number;
  engagedCount: number;
  mentions: SingleVoiceMention[];
}

export interface SingleVoiceOptions {
  /** Min mentions for capitalized entities (default 2). */
  minEntityMentions?: number;
  /** Min mentions for lowercase domain words — noisier, so higher (default 3). */
  minWordMentions?: number;
  /** Cap on topics returned (default 40). */
  maxTopics?: number;
}

// Capitalized word usable inside an entity phrase.
const CAP_WORD = String.raw`[A-Z][\w'’-]*`;
// Multi-word capitalized phrase (2-4 words) — counts anywhere in a sentence.
const CAP_PHRASE_RE = new RegExp(String.raw`\b${CAP_WORD}(?:\s+${CAP_WORD}){1,3}\b`, "g");
// Single capitalized word — only counts mid-sentence (preceded by a
// non-terminator char + whitespace), so ordinary sentence-initial
// capitalization doesn't turn every word into an "entity".
const CAP_SINGLE_RE = new RegExp(String.raw`([^.!?\n"“]\s)(${CAP_WORD})\b`, "g");
const ENGAGEMENT_LOOKAHEAD_TURNS = 3;
const ENGAGEMENT_MIN_CHARS = 40;
const SV_CONTEXT_WORDS = 10;

interface TermSighting {
  display: string;
  speaker: string;
  transcript: string;
  date?: string;
  timestamp?: string;
  turnIndex: number;
  context: string;
  engaged: boolean;
  entity: boolean;
}

/** One candidate token (entity phrase / mid-sentence cap word / domain term). */
export interface TurnToken {
  /** The matched text in its original casing. */
  display: string;
  start: number;
  end: number;
  /** True for capitalized entities, false for lowercase domain words. */
  entity: boolean;
}

/**
 * Enumerate the entity/term candidates in a single turn's text — the SHARED
 * token extraction that both `findSingleVoiceTopics` (asymmetric-knowledge
 * candidates) and `index-corpus` (per-transcript entities/terms) use, so the
 * index and the scan agree on what counts as an entity vs. a domain term.
 *
 * Yields, in source order: capitalized multi-word phrases (leading
 * sentence-initial stopwords stripped) and mid-sentence single capitalized
 * words as `entity: true`; stopword-filtered lowercase domain words as
 * `entity: false`. De-duplication and speaker/name filtering are the caller's
 * job — this only surfaces the raw candidates from the regexes.
 */
export function enumerateTurnTokens(text: string): TurnToken[] {
  const tokens: TurnToken[] = [];
  for (const m of text.matchAll(CAP_PHRASE_RE)) {
    // Strip leading capitalized stopwords ("The", "But", "I") that only
    // joined the phrase because they started a sentence.
    let phrase = m[0];
    let start = m.index;
    for (;;) {
      const first = /^(\S+)\s+/.exec(phrase);
      if (!first) break;
      const w = first[1]!.toLowerCase();
      if (!STOPWORDS.has(w) && w.length >= 2) break;
      phrase = phrase.slice(first[0].length);
      start += first[0].length;
    }
    // A 1-word remainder is handled by CAP_SINGLE_RE (let one path own singles).
    if (phrase.includes(" ")) tokens.push({ display: phrase, start, end: start + phrase.length, entity: true });
  }
  for (const m of text.matchAll(CAP_SINGLE_RE)) {
    const word = m[2]!;
    const start = m.index + m[1]!.length;
    tokens.push({ display: word, start, end: start + word.length, entity: true });
  }
  for (const m of text.toLowerCase().matchAll(TERM_RE)) {
    if (STOPWORDS.has(m[0])) continue;
    tokens.push({ display: text.slice(m.index, m.index + m[0].length), start: m.index, end: m.index + m[0].length, entity: false });
  }
  return tokens;
}

/**
 * Words that are part of any speaker label or participant email across the
 * given transcripts — a person's own name is not a content entity/term. Shared
 * by `findSingleVoiceTopics` (cross-corpus) and `extractTranscriptTerms`
 * (per-transcript, so the local names are filtered from that transcript's
 * entities/terms).
 */
export function collectNameWords(transcripts: Transcript[]): Set<string> {
  const nameWords = new Set<string>();
  for (const t of transcripts) {
    for (const turn of t.turns) {
      for (const w of (turn.speaker ?? "").toLowerCase().split(/\s+/)) {
        if (w) nameWords.add(w);
      }
    }
    for (const p of t.participants ?? []) {
      const local = p.split("@")[0] ?? "";
      for (const w of local.toLowerCase().split(/[._-]+/)) if (w) nameWords.add(w);
    }
  }
  return nameWords;
}

export interface TranscriptTerms {
  /** Capitalized entity phrases/words, original casing, frequency-ranked. */
  entities: string[];
  /** Lowercase stopword-filtered domain words, frequency-ranked. */
  terms: string[];
}

export interface TranscriptTermsOptions {
  /** Cap on entities returned (default 60). */
  maxEntities?: number;
  /** Cap on terms returned (default 60). */
  maxTerms?: number;
}

/**
 * Per-transcript entities + domain terms for the corpus index. Uses the SAME
 * `enumerateTurnTokens` extraction as `findSingleVoiceTopics`, so the index's
 * entity/term classification agrees with the novelty scan's (§2 step 4). Only
 * spoken turns are mined (a turn must have a speaker — Fireflies' AI summary
 * blocks are not speech); a transcript's own speaker/participant names are
 * filtered out. Output is de-duplicated by lowercased key and ranked by
 * frequency (then alphabetically), keeping the most common original casing.
 */
export function extractTranscriptTerms(
  transcript: Transcript,
  opts: TranscriptTermsOptions = {},
): TranscriptTerms {
  const maxEntities = opts.maxEntities ?? 60;
  const maxTerms = opts.maxTerms ?? 60;
  const nameWords = collectNameWords([transcript]);

  interface Agg {
    entity: boolean;
    count: number;
    displays: Map<string, number>;
  }
  const agg = new Map<string, Agg>();
  for (const turn of transcript.turns) {
    if (!turn.speaker) continue;
    const seenInTurn = new Set<string>();
    for (const tok of enumerateTurnTokens(turn.text)) {
      const key = tok.display.toLowerCase();
      if (key.length < 3) continue;
      if (STOPWORDS.has(key)) continue;
      if (key.split(/\s+/).some((w) => nameWords.has(w))) continue;
      if (seenInTurn.has(key)) continue; // one mention per turn per term
      seenInTurn.add(key);
      const a = agg.get(key) ?? { entity: tok.entity, count: 0, displays: new Map() };
      a.count += 1;
      a.entity ||= tok.entity;
      a.displays.set(tok.display, (a.displays.get(tok.display) ?? 0) + 1);
      agg.set(key, a);
    }
  }

  const bestDisplay = (a: Agg): string =>
    [...a.displays.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0];
  const rank = (predicate: (a: Agg) => boolean, max: number): string[] =>
    [...agg.entries()]
      .filter(([, a]) => predicate(a))
      .sort(([ka, a], [kb, b]) => b.count - a.count || ka.localeCompare(kb))
      .slice(0, max)
      .map(([, a]) => bestDisplay(a));

  return {
    entities: rank((a) => a.entity, maxEntities),
    terms: rank((a) => !a.entity, maxTerms),
  };
}

/**
 * Find terms/entities that exactly ONE speaker uses across the whole corpus
 * — asymmetric-knowledge candidates. Candidates are capitalized
 * phrases/mid-sentence capitalized words (entities) plus stopword-filtered
 * lowercase domain words (like recurringTerms). Speaker names and obvious
 * pronoun-cased words are excluded. Each mention carries context and an
 * engagement signal (did anyone substantively respond within 3 turns).
 * The agent judges which topics are genuinely asymmetric knowledge.
 */
export function findSingleVoiceTopics(
  transcripts: Transcript[],
  opts: SingleVoiceOptions = {},
): SingleVoiceTopic[] {
  const minEntity = opts.minEntityMentions ?? 2;
  const minWord = opts.minWordMentions ?? 3;
  const maxTopics = opts.maxTopics ?? 40;

  // Words that are part of any speaker label or participant email — a name
  // mentioned only by one person is not asymmetric knowledge.
  const nameWords = collectNameWords(transcripts);

  const sightings = new Map<string, TermSighting[]>();
  const add = (key: string, s: TermSighting) => {
    if (key.length < 3) return;
    if (STOPWORDS.has(key)) return;
    if (key.split(/\s+/).some((w) => nameWords.has(w))) return;
    (sightings.get(key) ?? sightings.set(key, []).get(key)!).push(s);
  };

  for (const t of transcripts) {
    for (const [turnIndex, turn] of t.turns.entries()) {
      if (!turn.speaker) continue;
      const engaged = hasEngagedReply(t, turnIndex);
      const seenInTurn = new Set<string>(); // count one mention per turn per term
      const record = (display: string, start: number, end: number, entity: boolean) => {
        const key = display.toLowerCase();
        if (seenInTurn.has(key)) return;
        seenInTurn.add(key);
        add(key, {
          display,
          speaker: turn.speaker!,
          transcript: t.path,
          date: t.date,
          timestamp: turn.timestamp,
          turnIndex,
          context: wordWindow(turn.text, start, end, SV_CONTEXT_WORDS),
          engaged,
          entity,
        });
      };

      // Shared token extraction (same helper index-corpus uses, so the index
      // and the scan agree on entity-vs-term classification).
      for (const tok of enumerateTurnTokens(turn.text)) {
        record(tok.display, tok.start, tok.end, tok.entity);
      }
    }
  }

  const topics: SingleVoiceTopic[] = [];
  for (const [term, list] of sightings) {
    const speakers = new Set(list.map((s) => s.speaker.toLowerCase()));
    if (speakers.size !== 1) continue;
    const entity = list.some((s) => s.entity);
    if (list.length < (entity ? minEntity : minWord)) continue;
    // Skip lowercase words that also appear as part of a longer entity the
    // speaker uses — keep the more specific signal only if both qualify.
    const mentions = list.map((s) => ({
      transcript: s.transcript,
      date: s.date,
      timestamp: s.timestamp,
      turnIndex: s.turnIndex,
      context: s.context,
      engaged: s.engaged,
    }));
    const displayCounts = new Map<string, number>();
    for (const s of list) displayCounts.set(s.display, (displayCounts.get(s.display) ?? 0) + 1);
    const display = [...displayCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    topics.push({
      term,
      display,
      speaker: list[0]!.speaker,
      entity,
      transcripts: [...new Set(list.map((s) => s.transcript))],
      mentionCount: list.length,
      engagedCount: list.filter((s) => s.engaged).length,
      mentions,
    });
  }

  return topics
    .sort(
      (a, b) =>
        Number(b.entity) - Number(a.entity) ||
        b.mentionCount - a.mentionCount ||
        a.term.localeCompare(b.term),
    )
    .slice(0, maxTopics);
}

function hasEngagedReply(t: Transcript, turnIndex: number): boolean {
  const speaker = t.turns[turnIndex]!.speaker?.toLowerCase();
  for (
    let i = turnIndex + 1;
    i < t.turns.length && i <= turnIndex + ENGAGEMENT_LOOKAHEAD_TURNS;
    i++
  ) {
    const turn = t.turns[i]!;
    if (!turn.speaker || turn.speaker.toLowerCase() === speaker) continue;
    if (turn.text.trim().length >= ENGAGEMENT_MIN_CHARS) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Narrative seeds — material-format matching for the podcast (the upstream lever)
// ---------------------------------------------------------------------------
//
// A card needs ONE insight; a podcast needs a sustained THROUGH-LINE across
// meetings — development, tension, a turn. That is a structurally higher bar,
// so the podcast survey must PRIORITIZE material that already has temporal
// development (a real before→after), not just "interesting things from recent
// meetings". This analyzer composes the existing deterministic signals
// (quantified drift, single-voice topics, cross-meeting term/entity spans) into
// ranked NARRATIVE SEEDS, each carrying its chronological evidence chain.
//
// It is a SURFACER, not a judge: it emits the arc skeleton (the evidence,
// ordered in time, with a measured "development" signal). The agent reads the
// chain and decides whether it is a real arc worth an episode. NO model calls.
//
// The cardinal rule that separates a seed from a card: a seed must span 2+
// meetings AND show development across them (a quantity that MOVED, a stance/
// topic that RECURS and evolves). A signal confined to one meeting — however
// interesting — is a card, never a lead. So every seed here has
// `transcripts.length >= 2` by construction.

export type NarrativeSeedKind =
  /** A tracked quantity whose VALUE changed across meetings — inherent arc. */
  | "quantified-drift"
  /** A single-voice topic that recurs across 3+ meetings — one person's arc. */
  | "single-voice-arc"
  /** An entity/term that spans 3+ meetings — a sustained through-line. */
  | "cross-meeting-topic";

/** One link in a seed's chronological evidence chain. */
export interface NarrativeEvidence {
  transcript: string;
  date?: string;
  timestamp?: string;
  turnIndex: number;
  speaker?: string;
  /** The concrete moment: a quantity value, or the term, with surrounding context. */
  value?: string;
  context: string;
}

export interface NarrativeSeed {
  kind: NarrativeSeedKind;
  /** Human-readable handle for the through-line (topic terms / entity / value). */
  label: string;
  /** Distinct transcripts the seed spans, in chronological order. */
  transcripts: string[];
  /**
   * Development score in [0,1]: how much the seed actually MOVES across the set.
   * Higher = stronger before→after. Drift where the value changed scores above
   * a value that merely recurs identically; a topic that spans more meetings
   * and changes speaker/stance scores above one that's mentioned flatly.
   * This is a deterministic proxy — the agent judges whether it's a real arc.
   */
  development: number;
  /** Composite rank score: development weighted by reach (meetings spanned). */
  score: number;
  /** The chronological evidence chain — the arc skeleton, ordered in time. */
  evidence: NarrativeEvidence[];
  /** Why this scored as it did (for the agent's read + the markdown report). */
  rationale: string;
}

export interface NarrativeSeedOptions {
  /** Cap on seeds returned (default 20). */
  maxSeeds?: number;
  /**
   * Min distinct meetings a single-voice / cross-meeting-topic seed must span
   * to count as an arc (default 3). Drift seeds need only 2 (a value that moved
   * between two meetings is already a before→after). A flat topic confined to
   * fewer meetings is a card, not an episode lead — so it is dropped here.
   */
  minSpanMeetings?: number;
}

/** Normalize a quantity value for change-detection: lowercase, strip $ , and spaces. */
function normalizeQuantityValue(value: string): string {
  return value.toLowerCase().replace(/[$,\s]/g, "");
}

/**
 * Count distinct normalized values in a drift group's chronological mentions,
 * and whether the FIRST and LAST differ (the clearest before→after). A group
 * where "$100k" became "50 grand" has movement; "$100k" repeated verbatim in
 * three meetings does not (it's a recurring fact, not an arc).
 */
function quantityMovement(mentions: QuantityMention[]): {
  distinctValues: number;
  endpointsDiffer: boolean;
} {
  const normalized = mentions.map((m) => normalizeQuantityValue(m.value));
  const distinctValues = new Set(normalized).size;
  const endpointsDiffer =
    normalized.length >= 2 && normalized[0] !== normalized[normalized.length - 1];
  return { distinctValues, endpointsDiffer };
}

/** Chronological order for a transcript path within an already-sorted mention set. */
function transcriptsInChronoOrder(mentions: { transcript: string }[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const m of mentions) {
    if (!seen.has(m.transcript)) {
      seen.add(m.transcript);
      order.push(m.transcript);
    }
  }
  return order;
}

/**
 * Score a transcript SET for NARRATIVE POTENTIAL and return ranked seeds, each
 * with its chronological evidence chain. Composes three deterministic signals:
 *
 *   1. quantified-drift   — a tracked quantity whose VALUE moved across 2+
 *                           meetings (the inherent arc: a number/commitment
 *                           that changed over time). Scored by how much it
 *                           moved (distinct values, endpoints differ) × reach.
 *   2. single-voice-arc   — a single-voice topic one person carries across
 *                           minSpanMeetings+ meetings, AND the room's
 *                           engagement with it SHIFTS across the set (stance
 *                           development). Reach alone is not development.
 *   3. cross-meeting-topic — an entity/term that recurs across minSpanMeetings+
 *                           meetings with multiple speakers AND shows a SHIFT —
 *                           it left and re-entered the agenda, or changed
 *                           hands across voices. Recurrence alone is not an arc.
 *
 * Development requires a real before→after for EVERY kind, not mere recurrence:
 * a flat topic that simply repeats across meetings has development floored at 0
 * (it sorts below every real arc and is labeled "recurrence only" — surfaced as
 * context, never scored as an arc), mirroring quantified-drift's drop of an
 * identical recurring value. Seeds are ranked by `score` (development × reach).
 * The agent reads the evidence chain and judges whether the arc is real — this
 * only surfaces the skeleton. A set with a real shift scores ABOVE a flat set.
 */
export function scoreNarrativeSeeds(
  transcripts: Transcript[],
  opts: NarrativeSeedOptions = {},
): NarrativeSeed[] {
  const maxSeeds = opts.maxSeeds ?? 20;
  const minSpan = opts.minSpanMeetings ?? 3;

  const seeds: NarrativeSeed[] = [];

  // --- 1. Quantified drift: a value that MOVED across meetings ---------------
  const quantities = trackQuantities(transcripts);
  for (const group of quantities.groups) {
    // trackQuantities already guarantees 2+ transcripts and chronological order.
    const { distinctValues, endpointsDiffer } = quantityMovement(group.mentions);
    // Reach: how many meetings the drift spans (2 = a clean before→after).
    const reach = group.transcripts.length;
    // Development: a value that actually changed is the arc. Endpoints differing
    // is the strongest signal; more distinct values adds to it; a value that
    // only recurs identically across meetings has near-zero development (it's a
    // fact the room already shares, not a story).
    let development = 0;
    if (endpointsDiffer) development += 0.6;
    development += Math.min(0.4, (distinctValues - 1) * 0.2); // 0 if all identical
    development = Math.min(1, development);
    if (development <= 0) continue; // no movement = no arc; it's a recurring fact
    seeds.push({
      kind: "quantified-drift",
      label: group.topicKey.length > 0 ? group.topicKey.join(", ") : group.mentions[0]!.value,
      transcripts: group.transcripts,
      development,
      score: development * reachWeight(reach),
      evidence: group.mentions.map((m) => ({
        transcript: m.transcript,
        date: m.date,
        timestamp: m.timestamp,
        turnIndex: m.turnIndex,
        speaker: m.speaker,
        value: m.value,
        context: m.context,
      })),
      rationale:
        `${distinctValues} distinct value(s) across ${reach} meeting(s)` +
        (endpointsDiffer
          ? `; first "${group.mentions[0]!.value}" → last "${group.mentions[group.mentions.length - 1]!.value}"`
          : "; endpoints unchanged (weak drift)"),
    });
  }

  // --- 2 & 3. Topic arcs spanning meetings -----------------------------------
  const singleVoice = findSingleVoiceTopics(transcripts);
  for (const topic of singleVoice) {
    if (topic.transcripts.length < minSpan) continue; // a topic in <minSpan meetings is a card
    const chronoMentions = [...topic.mentions].sort(chronoCompareSV);
    const orderedTranscripts = transcriptsInChronoOrder(chronoMentions);
    // Development for a single-voice arc: spanning more meetings is the arc, and
    // a SHIFT in engagement (the room ignored it early, then engaged — or vice
    // versa) is stance development worth surfacing.
    const reach = orderedTranscripts.length;
    const engagementShift = hasEngagementShift(chronoMentions);
    // Development must come from an actual SHIFT, not mere recurrence. For a
    // single-voice topic the only deterministic movement signal we have is an
    // engagement shift (the room ignored it early then engaged, or vice versa).
    // Reach alone is NOT development: the same person repeating the same point
    // identically across 3 meetings is flat recurrence, not an arc. With no
    // detected shift we floor development at 0 so the seed sorts below every
    // real arc and is labeled "recurrence only" — surfaced as context, never
    // scored as an arc. (Matches quantified-drift's "no movement = no arc".)
    let development = 0;
    if (engagementShift) {
      // A real stance shift: base on it, with reach adding to the ceiling.
      development = Math.min(1, 0.4 + Math.min(0.6, (reach - 2) * 0.25 + 0.1));
    }
    seeds.push({
      kind: "single-voice-arc",
      label: topic.display,
      transcripts: orderedTranscripts,
      development,
      score: development * reachWeight(reach),
      evidence: chronoMentions.map((m) => ({
        transcript: m.transcript,
        date: m.date,
        timestamp: m.timestamp,
        turnIndex: m.turnIndex,
        speaker: topic.speaker,
        context: m.context,
      })),
      rationale: engagementShift
        ? `only ${topic.speaker} voices "${topic.display}" across ${reach} meeting(s); engagement shifts across the set (stance development)`
        : `only ${topic.speaker} voices "${topic.display}" across ${reach} meeting(s); recurrence only, no detected development (engagement flat — surfaced as context, not an arc)`,
    });
  }

  // Cross-meeting topic: any entity/term recurring across minSpan+ meetings with
  // 2+ speakers — a sustained through-line the room kept returning to. Built from
  // the same token extraction the index/scan use, so classification agrees.
  for (const topic of crossMeetingTopics(transcripts, minSpan)) {
    const reach = topic.transcripts.length;
    // Development must come from an actual SHIFT, not mere recurrence. A topic
    // every meeting mentions flatly is a recurring fact, not an arc. Two
    // deterministic movement signals we can detect from the per-meeting
    // evidence + corpus chronology:
    //   - agenda movement: the topic LEFT and RE-ENTERED the agenda — it skips
    //     one or more meetings inside its span (it dropped off, then came back),
    //     which is a real before→after in the room's attention.
    //   - voice spread: a DIFFERENT speaker carries it across meetings — the
    //     thread moved from one voice to another (it spread / changed hands),
    //     rather than the same person repeating the same point.
    const { agendaMovement, voiceSpread } = topicDevelopmentSignals(
      topic,
      orderedTranscriptPaths(transcripts),
    );
    const hasShift = agendaMovement || voiceSpread;
    // No detected shift = flat recurrence: floor development at 0 so it sorts
    // below every real arc, and label it "recurrence only". Surfaced as
    // context, never scored as an arc. (Matches quantified-drift's `continue`
    // intent: recurrence alone is not development.)
    let development = 0;
    if (hasShift) {
      // Lower ceiling than drift (a topic moving is a weaker arc than a value
      // that moved) so drift outranks it at equal reach.
      development = Math.min(0.7, (reach - minSpan) * 0.15 + 0.3);
      if (topic.speakerCount >= 3) development += 0.1;
      development = Math.min(1, development);
    }
    const shiftNote = agendaMovement
      ? "left and re-entered the agenda (attention movement)"
      : voiceSpread
        ? "carried by a changing set of voices (the thread spread)"
        : "recurrence only, no detected development (surfaced as context, not an arc)";
    seeds.push({
      kind: "cross-meeting-topic",
      label: topic.display,
      transcripts: topic.transcripts,
      development,
      score: development * reachWeight(reach),
      evidence: topic.evidence,
      rationale: `"${topic.display}" recurs across ${reach} meeting(s), ${topic.speakerCount} speaker(s) — ${shiftNote}`,
    });
  }

  return seeds
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.transcripts.length - a.transcripts.length ||
        a.label.localeCompare(b.label),
    )
    .slice(0, maxSeeds);
}

/** Reach weight: a seed spanning more meetings has a higher structural ceiling. */
function reachWeight(meetings: number): number {
  // 2 meetings → 1.0, 3 → 1.3, 4 → 1.5, asymptotic — reach matters but a real
  // before→after across two meetings is already a valid arc.
  return 1 + Math.min(0.8, (meetings - 2) * 0.25);
}

/** Chronological compare for single-voice mentions (date → transcript → ts → turn). */
function chronoCompareSV(a: SingleVoiceMention, b: SingleVoiceMention): number {
  const dateA = a.date ?? "";
  const dateB = b.date ?? "";
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  if (a.transcript !== b.transcript) return a.transcript < b.transcript ? -1 : 1;
  const ta = timestampSeconds(a.timestamp);
  const tb = timestampSeconds(b.timestamp);
  if (ta !== tb) return ta - tb;
  return a.turnIndex - b.turnIndex;
}

/**
 * Did the room's engagement with a single-voice topic CHANGE across the
 * chronological mentions? A topic ignored in early meetings then engaged (or
 * vice versa) is a stance arc; uniform engagement is flat. Compares the
 * engaged-flag of the first vs. last mention as a cheap proxy.
 */
function hasEngagementShift(mentions: SingleVoiceMention[]): boolean {
  if (mentions.length < 2) return false;
  return mentions[0]!.engaged !== mentions[mentions.length - 1]!.engaged;
}

/** All transcript paths in corpus chronological order (date → path). */
function orderedTranscriptPaths(transcripts: Transcript[]): string[] {
  return [...transcripts]
    .sort((a, b) => {
      const da = a.date ?? "";
      const db = b.date ?? "";
      if (da !== db) return da < db ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    })
    .map((t) => t.path);
}

/**
 * Deterministic development signals for a cross-meeting topic — an actual SHIFT
 * across the set, never mere recurrence:
 *   - agendaMovement: the topic appears in NON-CONTIGUOUS meetings within its
 *     span — it left the agenda for one or more meetings, then came back. A
 *     before→after in the room's attention, not a steady drumbeat.
 *   - voiceSpread: the speaker who carries the topic CHANGES across meetings
 *     (first-sighting speaker differs between the earliest and a later meeting)
 *     — the thread moved from one voice to another rather than one person
 *     repeating it verbatim every standup.
 * If neither fires, the topic is flat recurrence (a sustained but undeveloped
 * fact), and the caller floors its development at 0.
 */
function topicDevelopmentSignals(
  topic: CrossMeetingTopic,
  corpusChrono: string[],
): { agendaMovement: boolean; voiceSpread: boolean } {
  // Agenda movement: the topic's meetings are not a contiguous run of the
  // corpus timeline — there is a corpus meeting between its first and last
  // sighting where the topic does NOT appear.
  const present = new Set(topic.transcripts);
  const firstIdx = corpusChrono.findIndex((p) => present.has(p));
  let lastIdx = -1;
  for (let i = corpusChrono.length - 1; i >= 0; i--) {
    if (present.has(corpusChrono[i]!)) {
      lastIdx = i;
      break;
    }
  }
  let agendaMovement = false;
  if (firstIdx >= 0 && lastIdx > firstIdx) {
    for (let i = firstIdx + 1; i < lastIdx; i++) {
      if (!present.has(corpusChrono[i]!)) {
        agendaMovement = true;
        break;
      }
    }
  }
  // Voice spread: the first-sighting speaker is not the same across all
  // meetings (the thread changed hands / spread, not one voice repeating).
  const speakers = topic.evidence
    .map((e) => (e.speaker ?? "").toLowerCase())
    .filter((s) => s.length > 0);
  const voiceSpread = new Set(speakers).size >= 2;
  return { agendaMovement, voiceSpread };
}

interface CrossMeetingTopic {
  display: string;
  transcripts: string[];
  speakerCount: number;
  evidence: NarrativeEvidence[];
}

/**
 * Entities/terms that recur across `minSpan`+ DISTINCT meetings, voiced by 2+
 * speakers — sustained cross-meeting through-lines. Uses the same
 * `enumerateTurnTokens` extraction as the index/scan so classification agrees,
 * and filters speaker names (`collectNameWords`). One mention per turn per term;
 * evidence is the first mention in each meeting, in chronological order.
 */
function crossMeetingTopics(
  transcripts: Transcript[],
  minSpan: number,
): CrossMeetingTopic[] {
  const nameWords = collectNameWords(transcripts);
  interface Agg {
    display: Map<string, number>;
    perMeeting: Map<string, NarrativeEvidence>; // first sighting per transcript
    speakers: Set<string>;
    entity: boolean;
  }
  const agg = new Map<string, Agg>();

  // Order transcripts chronologically up front so "first sighting per meeting"
  // and the evidence chain come out in time order.
  const ordered = [...transcripts].sort((a, b) => {
    const da = a.date ?? "";
    const db = b.date ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  for (const t of ordered) {
    for (const [turnIndex, turn] of t.turns.entries()) {
      if (!turn.speaker) continue;
      const seenInTurn = new Set<string>();
      for (const tok of enumerateTurnTokens(turn.text)) {
        const key = tok.display.toLowerCase();
        if (key.length < 3) continue;
        if (STOPWORDS.has(key)) continue;
        if (key.split(/\s+/).some((w) => nameWords.has(w))) continue;
        if (seenInTurn.has(key)) continue;
        seenInTurn.add(key);
        const a =
          agg.get(key) ??
          ({ display: new Map(), perMeeting: new Map(), speakers: new Set(), entity: tok.entity } as Agg);
        a.display.set(tok.display, (a.display.get(tok.display) ?? 0) + 1);
        a.entity ||= tok.entity;
        a.speakers.add(turn.speaker.toLowerCase());
        if (!a.perMeeting.has(t.path)) {
          a.perMeeting.set(t.path, {
            transcript: t.path,
            date: t.date,
            timestamp: turn.timestamp,
            turnIndex,
            speaker: turn.speaker,
            context: wordWindow(turn.text, tok.start, tok.end, SV_CONTEXT_WORDS),
          });
        }
        agg.set(key, a);
      }
    }
  }

  const out: CrossMeetingTopic[] = [];
  for (const a of agg.values()) {
    if (a.perMeeting.size < minSpan) continue; // must span minSpan+ meetings
    if (a.speakers.size < 2) continue; // a single speaker is single-voice, not cross
    const display = [...a.display.entries()].sort(
      (x, y) => y[1] - x[1] || x[0].localeCompare(y[0]),
    )[0]![0];
    const evidence = [...a.perMeeting.values()]; // already chronological (ordered scan)
    out.push({
      display,
      transcripts: evidence.map((e) => e.transcript),
      speakerCount: a.speakers.size,
      evidence,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prior-artifact index — the novelty baseline
// ---------------------------------------------------------------------------

export interface PriorArtifact {
  /** Path to the artifact.json. */
  path: string;
  type: string;
  slug: string;
  headline: string;
  tags: string[];
  quote?: string;
  source_transcripts: string[];
  source_quotes: string[];
  generated_at?: string;
  notes?: string;
}

export interface PriorArtifactIndex {
  artifactsDir: string;
  /** Sorted by generated_at (oldest first), undated last. */
  entries: PriorArtifact[];
  /** Unreadable/malformed files noted here, never thrown. */
  warnings: string[];
}

/**
 * Index everything previous runs already surfaced: scan
 * <artifactsDir>/<type>/<slug>/artifact.json (the gitignored output tree,
 * read at runtime) and return headlines, tags, quotes, and source
 * transcripts. This is the NOVELTY BASELINE — a candidate angle that a
 * prior artifact already covered is disqualified unless the agent can say
 * something materially new about it. A missing dir is fine (fresh repo):
 * empty index, no throw.
 */
export async function priorArtifactIndex(artifactsDir: string): Promise<PriorArtifactIndex> {
  const index: PriorArtifactIndex = { artifactsDir, entries: [], warnings: [] };
  let typeDirs: string[];
  try {
    typeDirs = await listDirs(artifactsDir);
  } catch {
    return index; // no artifacts dir yet — empty baseline
  }
  for (const typeDir of typeDirs) {
    let slugDirs: string[] = [];
    try {
      slugDirs = await listDirs(join(artifactsDir, typeDir));
    } catch {
      continue;
    }
    for (const slugDir of slugDirs) {
      const jsonPath = join(artifactsDir, typeDir, slugDir, "artifact.json");
      try {
        const a = JSON.parse(await readFile(jsonPath, "utf8")) as Record<string, unknown>;
        if (typeof a.headline !== "string") {
          index.warnings.push(`${jsonPath}: no headline — skipped`);
          continue;
        }
        index.entries.push({
          path: jsonPath,
          type: typeof a.type === "string" ? a.type : typeDir,
          slug: basename(slugDir),
          headline: a.headline,
          tags: Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : [],
          quote: typeof a.quote === "string" ? a.quote : undefined,
          source_transcripts: Array.isArray(a.source_transcripts)
            ? a.source_transcripts.filter((s): s is string => typeof s === "string")
            : [],
          source_quotes: Array.isArray(a.source_quotes)
            ? (a.source_quotes as Record<string, unknown>[])
                .map((q) => q?.quote)
                .filter((q): q is string => typeof q === "string")
            : [],
          generated_at: typeof a.generated_at === "string" ? a.generated_at : undefined,
          notes:
            typeof (a.quality as Record<string, unknown> | undefined)?.notes === "string"
              ? ((a.quality as Record<string, unknown>).notes as string)
              : undefined,
        });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // media-only dir
        index.warnings.push(`${jsonPath}: ${(e as Error).message}`);
      }
    }
  }
  index.entries.sort((a, b) => {
    const ga = a.generated_at ?? "9999";
    const gb = b.generated_at ?? "9999";
    return ga < gb ? -1 : ga > gb ? 1 : a.path.localeCompare(b.path);
  });
  return index;
}

async function listDirs(path: string): Promise<string[]> {
  const entries = await readdir(path);
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if ((await stat(join(path, entry))).isDirectory()) dirs.push(entry);
  }
  return dirs.sort();
}

// ---------------------------------------------------------------------------
// Combined scan + markdown rendering (used by the novelty-scan CLI)
// ---------------------------------------------------------------------------

export interface NoveltyScan {
  transcriptCount: number;
  quantities: QuantityTrack;
  singleVoice: SingleVoiceTopic[];
  baseline: PriorArtifactIndex;
}

export async function buildNoveltyScan(
  transcripts: Transcript[],
  artifactsDir: string,
): Promise<NoveltyScan> {
  return {
    transcriptCount: transcripts.length,
    quantities: trackQuantities(transcripts),
    singleVoice: findSingleVoiceTopics(transcripts),
    baseline: await priorArtifactIndex(artifactsDir),
  };
}

function mentionLine(m: QuantityMention): string {
  const who = m.speaker ?? "(unattributed)";
  const when = [m.date, m.timestamp].filter(Boolean).join(" ");
  return `- ${when ? `${when} — ` : ""}**${m.value}** (${m.kind}) — ${who}: “…${m.context}…” \`${m.transcript}\``;
}

/**
 * Render a scan as a readable markdown report (same information as the
 * JSON). Candidates only — every section reminds the agent that judgment
 * happens after reading, not here.
 */
export function renderNoveltyMarkdown(scan: NoveltyScan): string {
  const out: string[] = [];
  out.push("# Novelty scan");
  out.push("");
  out.push(`- transcripts: ${scan.transcriptCount}`);
  out.push(`- drift candidate groups (2+ transcripts): ${scan.quantities.groups.length}`);
  out.push(`- notable single quantities: ${scan.quantities.singles.length}`);
  out.push(`- single-voice topics: ${scan.singleVoice.length}`);
  out.push(`- prior artifacts (novelty baseline): ${scan.baseline.entries.length}`);
  out.push("");
  out.push(
    "Candidates, not conclusions: the analyzers surface evidence; you judge" +
      " whether a delta is drift, a single-voice topic is asymmetric" +
      " knowledge, or an angle beats the prior-artifact baseline.",
  );

  out.push("");
  out.push("## Quantified claims — drift candidates (same topic, 2+ transcripts, chronological)");
  if (scan.quantities.groups.length === 0) {
    out.push("");
    out.push("- (none)");
  }
  for (const g of scan.quantities.groups) {
    out.push("");
    out.push(`### Topic: ${g.topicKey.join(", ") || "(weak key — read the contexts)"}`);
    out.push("");
    for (const m of g.mentions) out.push(mentionLine(m));
  }

  out.push("");
  out.push("## Notable single quantities");
  out.push("");
  if (scan.quantities.singles.length === 0) out.push("- (none)");
  for (const m of scan.quantities.singles) out.push(mentionLine(m));

  out.push("");
  out.push("## Single-voice topics (one speaker, zero echo from anyone else)");
  out.push("");
  if (scan.singleVoice.length === 0) out.push("- (none)");
  for (const t of scan.singleVoice) {
    out.push(
      `- **${t.display}** — only ${t.speaker} (${t.mentionCount} mention(s), ` +
        `${t.engagedCount} with substantive replies, ${t.transcripts.length} transcript(s))`,
    );
    for (const m of t.mentions) {
      const when = [m.date, m.timestamp].filter(Boolean).join(" ");
      out.push(
        `  - ${when ? `${when} — ` : ""}“…${m.context}…” ` +
          `${m.engaged ? "[engaged]" : "[no engagement]"} \`${m.transcript}\``,
      );
    }
  }

  out.push("");
  out.push("## Prior-artifact baseline (already surfaced — candidate angles must beat this)");
  out.push("");
  if (scan.baseline.entries.length === 0) {
    out.push(`- (none under ${scan.baseline.artifactsDir})`);
  }
  for (const e of scan.baseline.entries) {
    out.push(`- [${e.type}] **${e.headline}**${e.generated_at ? ` (${e.generated_at})` : ""}`);
    if (e.tags.length > 0) out.push(`  - tags: ${e.tags.join(", ")}`);
    if (e.quote) out.push(`  - quote: “${e.quote}”`);
    if (e.source_transcripts.length > 0)
      out.push(`  - sources: ${e.source_transcripts.join(", ")}`);
  }
  for (const w of scan.baseline.warnings) out.push(`- WARNING: ${w}`);
  out.push("");
  return out.join("\n");
}

/**
 * Render ranked narrative seeds as a readable markdown report — the arc
 * skeleton for the podcast survey. Each seed shows its kind, reach, development
 * score, and the chronological evidence chain (the before→after). Candidates
 * only: the agent reads the chain and judges whether the arc is real.
 */
export function renderNarrativeSeedsMarkdown(seeds: NarrativeSeed[]): string {
  const out: string[] = [];
  out.push("# Narrative seeds (podcast survey — material-format matching)");
  out.push("");
  out.push(
    "A podcast needs a sustained through-line across meetings (a real" +
      " before→after), not a single insight. These seeds are ranked by" +
      " narrative potential (development × reach). Each is a CANDIDATE arc" +
      " skeleton — read the chronological evidence chain and judge whether the" +
      " development is real. A seed confined to one meeting is a card, not a" +
      " lead, and never appears here.",
  );
  out.push("");
  out.push(`- seeds: ${seeds.length}`);
  if (seeds.length === 0) {
    out.push("");
    out.push(
      "- (none — no through-line shows temporal development across 2+" +
        " meetings. Zero episodes is a valid result: do not lead with a flat" +
        " recap of recent meetings.)",
    );
    out.push("");
    return out.join("\n");
  }
  for (const s of seeds) {
    out.push("");
    out.push(
      `## [${s.kind}] ${s.label} — score ${s.score.toFixed(2)} ` +
        `(development ${s.development.toFixed(2)}, ${s.transcripts.length} meeting(s))`,
    );
    out.push("");
    out.push(`- ${s.rationale}`);
    out.push("- evidence chain (chronological):");
    for (const e of s.evidence) {
      const when = [e.date, e.timestamp].filter(Boolean).join(" ");
      const who = e.speaker ?? "(unattributed)";
      const val = e.value ? `**${e.value}** — ` : "";
      out.push(
        `  - ${when ? `${when} — ` : ""}${who}: ${val}“…${e.context}…” \`${e.transcript}\``,
      );
    }
  }
  out.push("");
  return out.join("\n");
}
