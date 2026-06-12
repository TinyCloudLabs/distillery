// salient-people-lib.ts — the testable plumbing for the SALIENT-PEOPLE detector
// (Phase 1b — person-brief on salience).
//
// THE BOUNDARY (base SPEC, non-negotiable): this is DETERMINISTIC surfacing, NOT
// judgment. It reads the corpus index + the existing person-brief artifacts and
// answers one mechanical question: which people/speakers recur across the corpus
// (>= N transcripts) but do NOT yet have a current person-brief? It NEVER decides
// whether a brief is worth writing — that judgment stays with the generation
// agent. NO model calls; pure over the index records + the artifacts dir scan.
//
// The recipe runs this before the brief, embeds the top candidates, and the
// generation agent generates person-briefs for the salient un-briefed people it
// judges worth a dossier (capped, internal audience → publishes to the feed).
//
// Everything testable (the tally, the already-briefed exclusion, the ranking)
// lives here and is imported by both the CLI (salient-people.ts) and the tests.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CorpusIndex, IndexRecord } from "../../index-corpus/scripts/corpus-index.ts";
import { slugify } from "../../../skills/_shared/lib/artifact.ts";

/** The default salience threshold: a person must speak across >= N transcripts. */
export const DEFAULT_SALIENCE_MIN_TRANSCRIPTS = 3;

/** The default number of top candidates surfaced into the brief (cost guard). */
export const DEFAULT_SALIENT_TOP = 5;

/** One salient-person candidate: a recurring speaker without a current brief. */
export interface SalientPerson {
  /** The speaker name exactly as it appears in the index (display form). */
  name: string;
  /** slugify(name) — the key matched against artifacts/person-brief/<slug>/. */
  slug: string;
  /** How many DISTINCT transcripts this person spoke across (the salience score). */
  transcriptCount: number;
  /** Total speaking turns across those transcripts (the deterministic tiebreak). */
  turnCount: number;
}

/**
 * Tally each speaker's distinct-transcript count + total turns across the index.
 * Pure over the records. Empty transcripts contribute nothing (they carry no
 * real speakers). Returns a name → {transcriptCount, turnCount} map.
 *
 * A "speaker" here is a real conversational participant from the index's
 * speakerTurnCounts — the same field index-corpus extracts from transcript turns.
 * We deliberately use SPEAKERS (people who actually spoke), not entities, so the
 * salience signal is grounded in real meeting participation, not name-drops.
 */
export function tallySpeakers(
  records: IndexRecord[],
): Map<string, { transcriptCount: number; turnCount: number }> {
  const tally = new Map<string, { transcriptCount: number; turnCount: number }>();
  for (const r of records) {
    if (r.empty) continue;
    for (const [rawName, turns] of Object.entries(r.speakerTurnCounts ?? {})) {
      const name = rawName.trim();
      if (!name) continue;
      const entry = tally.get(name) ?? { transcriptCount: 0, turnCount: 0 };
      entry.transcriptCount += 1; // this is one DISTINCT transcript for the speaker
      entry.turnCount += turns;
      tally.set(name, entry);
    }
  }
  return tally;
}

/**
 * Scan artifacts/person-brief/ for the set of slugs that already have a CURRENT
 * brief (a folder containing an artifact.json). Never throws — a missing dir →
 * empty set, matching scanArtifacts / priorArtifactIndex. The slug is the folder
 * name (writeArtifact slugifies the headline, which for a person-brief is the
 * person's name), so we compare against slugify(speakerName).
 */
export async function existingBriefSlugs(artifactsDir: string): Promise<Set<string>> {
  const slugs = new Set<string>();
  const typeDir = join(artifactsDir, "person-brief");
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await readdir(typeDir, { withFileTypes: true });
  } catch {
    return slugs; // no person-brief dir yet → nobody briefed
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      await readFile(join(typeDir, e.name, "artifact.json"), "utf8");
    } catch {
      continue; // a half-written/stray folder is not a current brief
    }
    slugs.add(e.name);
  }
  return slugs;
}

export interface SalientPeopleOptions {
  /** Salience threshold — a person must appear across >= this many transcripts. */
  minTranscripts?: number;
  /** Cap on the number of candidates returned (top-N by salience). */
  top?: number;
  /** Slugs that already have a current person-brief (excluded from candidates). */
  alreadyBriefed?: Set<string>;
}

/**
 * The detector core (PURE — no I/O): given index records + the already-briefed
 * slug set, return the top-N salient un-briefed people. A candidate must:
 *   - have spoken across >= minTranscripts DISTINCT transcripts (the salience bar),
 *   - NOT already have a current person-brief (slugify(name) not in alreadyBriefed).
 * Ranked by transcriptCount desc, then turnCount desc, then name (stable). NO
 * model calls; the agent later judges whether each is worth a dossier.
 */
export function detectSalientPeople(
  records: IndexRecord[],
  opts: SalientPeopleOptions = {},
): SalientPerson[] {
  const minTranscripts = opts.minTranscripts ?? DEFAULT_SALIENCE_MIN_TRANSCRIPTS;
  const top = opts.top ?? DEFAULT_SALIENT_TOP;
  const alreadyBriefed = opts.alreadyBriefed ?? new Set<string>();

  const tally = tallySpeakers(records);
  const candidates: SalientPerson[] = [];
  for (const [name, { transcriptCount, turnCount }] of tally) {
    if (transcriptCount < minTranscripts) continue;
    const slug = slugify(name);
    if (alreadyBriefed.has(slug)) continue; // a current brief already exists
    candidates.push({ name, slug, transcriptCount, turnCount });
  }
  candidates.sort(
    (a, b) =>
      b.transcriptCount - a.transcriptCount ||
      b.turnCount - a.turnCount ||
      a.name.localeCompare(b.name),
  );
  return candidates.slice(0, top);
}

/**
 * End-to-end detector over a loaded index + an artifacts dir (does the I/O: reads
 * the already-briefed slugs, then runs the pure core). Returns the top-N salient
 * un-briefed people. Never throws on a missing artifacts dir.
 */
export async function findSalientPeople(
  index: CorpusIndex,
  artifactsDir: string,
  opts: Omit<SalientPeopleOptions, "alreadyBriefed"> = {},
): Promise<SalientPerson[]> {
  const alreadyBriefed = await existingBriefSlugs(artifactsDir);
  return detectSalientPeople(index.transcripts, { ...opts, alreadyBriefed });
}

/** A one-line summary for the run-log / stderr (counts only — no judgment). */
export function summarizeSalient(people: SalientPerson[], minTranscripts: number): string {
  if (people.length === 0) {
    return `no salient un-briefed people (>= ${minTranscripts} transcripts)`;
  }
  const list = people.map((p) => `${p.name}(${p.transcriptCount})`).join(", ");
  return `${people.length} salient un-briefed person(s) [${list}]`;
}
