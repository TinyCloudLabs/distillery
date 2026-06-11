// article.ts — deterministic helpers for the write-article skill.
//
// Everything here is plumbing: parsing digests, quote verification, and
// artifact persistence. The editorial judgment (angle selection, outlining,
// drafting, critic pass) belongs to the agent reading SKILL.md — no model
// calls happen in this file or in any script that imports it.

import { readFile } from "node:fs/promises";
import {
  chunkTranscript,
  parseTranscript,
  verifyQuote,
  type Transcript,
  type TranscriptChunk,
} from "../../_shared/lib/transcript.ts";
import {
  newArtifactId,
  validateArtifact,
  writeArtifact,
  type SourceQuote,
  type WrittenArtifact,
} from "../../_shared/lib/artifact.ts";
import { STOPWORDS, TERM_RE } from "../../_shared/lib/stopwords.ts";

// ---------------------------------------------------------------------------
// Digest — survey input for the agent's angle selection
// ---------------------------------------------------------------------------

export interface SpeakerStat {
  speaker: string;
  turns: number;
}

export interface DigestTranscript {
  path: string;
  title?: string;
  date?: string;
  participants?: string[];
  summary?: string;
  turnCount: number;
  speakers: SpeakerStat[];
  /** Per-speaker turn counts keyed by speaker label, e.g. {"Ada Lovelace": 7}. */
  speakerTurnCounts: Record<string, number>;
}

export interface RecurringTerm {
  term: string;
  /** Number of distinct transcripts the term appears in (always >= 2 here). */
  transcriptCount: number;
  occurrences: number;
}

export interface CrossTranscriptDigest {
  /** Speakers (case-insensitive match) who appear in 2+ transcripts. */
  sharedSpeakers: { speaker: string; transcripts: string[] }[];
  /** Non-stopword terms recurring across 2+ transcripts — angle hints only. */
  recurringTerms: RecurringTerm[];
}

export interface ArticleDigest {
  mode: "single" | "collection";
  transcriptCount: number;
  transcripts: DigestTranscript[];
  /** Present only in collection mode (2+ transcripts). */
  crossTranscript?: CrossTranscriptDigest;
  chunks: TranscriptChunk[];
}

const MAX_RECURRING_TERMS = 30;

/**
 * Build the survey digest the agent reads before choosing an editorial
 * angle. Deterministic: same transcripts in, same digest out.
 */
export function buildDigest(
  transcripts: Transcript[],
  maxChunk = 8000,
): ArticleDigest {
  const digestTranscripts: DigestTranscript[] = transcripts.map((t) => {
    const turnsBySpeaker = new Map<string, number>();
    for (const turn of t.turns) {
      if (!turn.speaker) continue;
      turnsBySpeaker.set(turn.speaker, (turnsBySpeaker.get(turn.speaker) ?? 0) + 1);
    }
    const speakers = [...turnsBySpeaker.entries()]
      .map(([speaker, turns]) => ({ speaker, turns }))
      .sort((a, b) => b.turns - a.turns || a.speaker.localeCompare(b.speaker));
    return {
      path: t.path,
      title: t.title,
      date: t.date,
      participants: t.participants,
      summary: t.summary,
      turnCount: t.turns.length,
      speakers,
      speakerTurnCounts: Object.fromEntries(speakers.map((s) => [s.speaker, s.turns])),
    };
  });

  const digest: ArticleDigest = {
    mode: transcripts.length >= 2 ? "collection" : "single",
    transcriptCount: transcripts.length,
    transcripts: digestTranscripts,
    chunks: transcripts.flatMap((t) => chunkTranscript(t, maxChunk)),
  };

  if (transcripts.length >= 2) {
    digest.crossTranscript = buildCrossTranscript(transcripts);
  }
  return digest;
}

function buildCrossTranscript(transcripts: Transcript[]): CrossTranscriptDigest {
  // Shared speakers (case-insensitive name match across transcripts).
  const speakerPaths = new Map<string, { speaker: string; paths: Set<string> }>();
  for (const t of transcripts) {
    for (const turn of t.turns) {
      if (!turn.speaker) continue;
      const key = turn.speaker.trim().toLowerCase();
      const entry = speakerPaths.get(key) ?? { speaker: turn.speaker.trim(), paths: new Set<string>() };
      entry.paths.add(t.path);
      speakerPaths.set(key, entry);
    }
  }
  const sharedSpeakers = [...speakerPaths.values()]
    .filter((e) => e.paths.size >= 2)
    .map((e) => ({ speaker: e.speaker, transcripts: [...e.paths].sort() }))
    .sort((a, b) => b.transcripts.length - a.transcripts.length || a.speaker.localeCompare(b.speaker));

  // Recurring terms: non-stopword words present in 2+ transcripts.
  const termStats = new Map<string, { paths: Set<string>; occurrences: number }>();
  for (const t of transcripts) {
    const text = t.turns.map((turn) => turn.text).join("\n").toLowerCase();
    for (const match of text.matchAll(TERM_RE)) {
      const term = match[0];
      if (STOPWORDS.has(term)) continue;
      const entry = termStats.get(term) ?? { paths: new Set<string>(), occurrences: 0 };
      entry.paths.add(t.path);
      entry.occurrences++;
      termStats.set(term, entry);
    }
  }
  const recurringTerms = [...termStats.entries()]
    .filter(([, s]) => s.paths.size >= 2)
    .map(([term, s]) => ({ term, transcriptCount: s.paths.size, occurrences: s.occurrences }))
    .sort(
      (a, b) =>
        b.transcriptCount - a.transcriptCount ||
        b.occurrences - a.occurrences ||
        a.term.localeCompare(b.term),
    )
    .slice(0, MAX_RECURRING_TERMS);

  return { sharedSpeakers, recurringTerms };
}

/**
 * Render the digest as a human/agent-readable markdown document: survey
 * metadata, per-transcript speaker turn counts, cross-transcript hints, then
 * every chunk as a plain text section. Same information as the JSON digest,
 * built for reading rather than parsing.
 */
export function renderDigestMarkdown(digest: ArticleDigest): string {
  const out: string[] = [];
  out.push("# Article survey digest");
  out.push("");
  out.push(`- mode: ${digest.mode}`);
  out.push(`- transcripts: ${digest.transcriptCount}`);
  out.push(`- chunks: ${digest.chunks.length}`);

  for (const t of digest.transcripts) {
    out.push("");
    out.push(`## Transcript: ${t.title ?? t.path}`);
    out.push("");
    out.push(`- path: ${t.path}`);
    if (t.date) out.push(`- date: ${t.date}`);
    if (t.participants?.length) out.push(`- participants: ${t.participants.join(", ")}`);
    out.push(`- turns: ${t.turnCount}`);
    if (t.speakers.length > 0) {
      out.push("");
      out.push("Speaker turn counts:");
      out.push("");
      for (const s of t.speakers) out.push(`- ${s.speaker}: ${s.turns}`);
    }
    if (t.summary) {
      out.push("");
      out.push("### Pre-written summary (AI-generated header — not spoken text)");
      out.push("");
      out.push(t.summary);
    }
  }

  const cross = digest.crossTranscript;
  if (cross) {
    out.push("");
    out.push("## Cross-transcript signals");
    out.push("");
    out.push("Shared speakers (appear in 2+ transcripts):");
    out.push("");
    if (cross.sharedSpeakers.length === 0) out.push("- (none)");
    for (const s of cross.sharedSpeakers) {
      out.push(`- ${s.speaker} — ${s.transcripts.join(", ")}`);
    }
    out.push("");
    out.push("Recurring terms (frequency hints only — read the chunks before concluding anything):");
    out.push("");
    if (cross.recurringTerms.length === 0) out.push("- (none)");
    for (const rt of cross.recurringTerms) {
      out.push(
        `- ${rt.term} — ${rt.transcriptCount} transcripts, ${rt.occurrences} occurrences`,
      );
    }
  }

  out.push("");
  out.push("## Chunks");
  for (const c of digest.chunks) {
    out.push("");
    out.push(`### Chunk ${c.index} — ${c.transcript}`);
    out.push("");
    out.push(c.text);
  }
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Quote verification — same contract as extract-insights' verify-quotes
// ---------------------------------------------------------------------------

export interface QuoteFailure {
  index: number;
  quote: string;
  transcript: string;
  reason: string;
}

/**
 * Verify every source_quote verbatim (whitespace-insensitive) against its
 * transcript file. Returns the failures; an empty array means all verified.
 */
export async function verifyArtifactQuotes(
  quotes: SourceQuote[],
): Promise<QuoteFailure[]> {
  const cache = new Map<string, Transcript>();
  const failures: QuoteFailure[] = [];
  for (const [index, sq] of quotes.entries()) {
    try {
      let transcript = cache.get(sq.transcript);
      if (!transcript) {
        transcript = parseTranscript(await readFile(sq.transcript, "utf8"), sq.transcript);
        cache.set(sq.transcript, transcript);
      }
      if (!verifyQuote(transcript, sq.quote)) {
        failures.push({
          index,
          quote: sq.quote,
          transcript: sq.transcript,
          reason: "quote not found verbatim in transcript",
        });
      }
    } catch (e) {
      failures.push({
        index,
        quote: sq.quote,
        transcript: sq.transcript,
        reason: `could not read transcript: ${(e as Error).message}`,
      });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Save — validate + persist artifact.json with body.md alongside
// ---------------------------------------------------------------------------

/** Target editorial length; outside this range save warns (non-fatal). */
export const TARGET_WORDS_MIN = 400;
export const TARGET_WORDS_MAX = 900;

export interface SavedArticle {
  written: WrittenArtifact;
  wordCount: number;
  warnings: string[];
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Normalize, validate, and persist an article artifact. Writes
 * <outDir>/article/<slug>/artifact.json plus body.md (the markdown body)
 * alongside it. Throws on contract violations.
 *
 * Article-specific rules on top of the shared contract:
 * - type must be "article" (defaulted when missing);
 * - body is required (the article *is* the body);
 * - hero_image: null is stripped — the independently-callable
 *   illustrate-card skill fills it in later.
 */
export async function saveArticle(
  raw: Record<string, unknown>,
  opts: { outDir?: string } = {},
): Promise<SavedArticle> {
  raw.id ??= newArtifactId();
  raw.generated_at ??= new Date().toISOString();
  raw.type ??= "article";
  if (raw.type !== "article") {
    throw new Error(`write-article only saves type "article" (got "${String(raw.type)}")`);
  }
  // Articles start un-illustrated; null means "no hero image yet", which the
  // contract expresses by omission.
  if (raw.hero_image === null) delete raw.hero_image;

  if (typeof raw.body !== "string" || !raw.body.trim()) {
    throw new Error("article artifacts require a non-empty markdown body");
  }

  const result = validateArtifact(raw);
  if (!result.ok) {
    throw new Error(`Artifact failed contract validation:\n  - ${result.errors.join("\n  - ")}`);
  }

  const body = result.artifact.body ?? "";
  const wordCount = countWords(body);
  const warnings: string[] = [];
  if (wordCount < TARGET_WORDS_MIN || wordCount > TARGET_WORDS_MAX) {
    warnings.push(
      `body is ${wordCount} words; target is ~${TARGET_WORDS_MIN}-${TARGET_WORDS_MAX}`,
    );
  }

  const written = await writeArtifact(result.artifact, {
    outDir: opts.outDir,
    media: { "body.md": new TextEncoder().encode(body.endsWith("\n") ? body : body + "\n") },
  });
  return { written, wordCount, warnings };
}
