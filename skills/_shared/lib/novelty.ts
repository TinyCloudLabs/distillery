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
export function trackQuantities(transcripts: Transcript[]): QuantityTrack {
  const mentions: QuantityMention[] = [];
  for (const t of transcripts) {
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
  }

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

      for (const m of turn.text.matchAll(CAP_PHRASE_RE)) {
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
        if (phrase.includes(" ")) {
          record(phrase, start, start + phrase.length, true);
        }
        // A 1-word remainder is handled by CAP_SINGLE_RE (it is mid-sentence
        // by construction here, but let one code path own singles).
      }
      for (const m of turn.text.matchAll(CAP_SINGLE_RE)) {
        const word = m[2]!;
        const start = m.index + m[1]!.length;
        record(word, start, start + word.length, true);
      }
      for (const m of turn.text.toLowerCase().matchAll(TERM_RE)) {
        if (STOPWORDS.has(m[0])) continue;
        record(turn.text.slice(m.index, m.index + m[0].length), m.index, m.index + m[0].length, false);
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
