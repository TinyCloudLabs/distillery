// corpus-index.ts — deterministic plumbing for the index-corpus skill.
//
// Builds and maintains a fast, incremental, content-hash-gated index of the
// whole transcript corpus so the agent (and query-corpus) never re-parse the
// ~394 files every run. SURFACING ONLY — no model calls, no judgment here; the
// agent reading SKILL.md decides what to do with the index.
//
// Incrementality: each record stores a sha256 of the file's raw bytes. On a
// rebuild, a file whose hash matches its existing record is loaded straight
// from the index (NOT re-parsed); only new or changed files are parsed. This
// is the whole point — repeated runs over an unchanged corpus do ~zero work.
//
// The CLI wrapper (index-corpus.ts) handles argv + env resolution; everything
// testable lives here and is imported by both the CLI and the tests.

import { readdir, readFile, rename, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseTranscript, transcriptDuration, type Transcript } from "../../_shared/lib/transcript.ts";
import {
  collectQuantityMentions,
  extractTranscriptTerms,
  type QuantityKind,
} from "../../_shared/lib/novelty.ts";

/** Index schema version. Bump when a record's shape changes incompatibly. */
export const INDEX_VERSION = 1;

const TRANSCRIPT_EXTENSIONS = new Set([".md", ".txt"]);

/** A per-transcript quantity mention as stored in the index (§2 schema). */
export interface IndexQuantity {
  kind: QuantityKind;
  value: string;
  speaker?: string;
  timestamp?: string;
  context: string;
}

/** One transcript's index record. Keyed by absolute `path`. */
export interface IndexRecord {
  path: string;
  source: "fireflies" | "gemini" | "soundcore" | "unknown";
  title?: string;
  date?: string;
  speakers: string[];
  speakerTurnCounts: Record<string, number>;
  turnCount: number;
  duration?: string;
  entities: string[];
  terms: string[];
  quantities: IndexQuantity[];
  /** "sha256:<hex>" of the file's raw bytes — change detection. */
  content_hash: string;
  /** ISO timestamp this record was (re)built. */
  indexed_at: string;
  /** True for flagged-empty transcripts (kept, but excluded from queries). */
  empty: boolean;
}

export interface CorpusIndex {
  version: number;
  generated_at: string;
  transcript_dirs: string[];
  transcripts: IndexRecord[];
  warnings: string[];
}

/** Per-run counts the CLI prints (no content, just numbers). */
export interface IndexRunStats {
  total: number;
  /** Files parsed this run (new or changed). */
  reprocessed: number;
  /** Files loaded from the existing index unchanged (hash matched). */
  unchanged: number;
  added: number;
  /** Records dropped because the source file vanished (only with prune). */
  pruned: number;
  /** Flagged-empty transcripts in the resulting index. */
  empty: number;
  warnings: number;
}

export interface BuildIndexOptions {
  /** Roots to walk (dirs recursed; individual files accepted too). */
  inputs: string[];
  /** Existing index to reuse unchanged records from (incremental). */
  previous?: CorpusIndex;
  /** Ignore hashes and re-parse everything. */
  full?: boolean;
  /** Drop records whose source file no longer exists. */
  prune?: boolean;
  /** Override the timestamp (tests); defaults to now. */
  now?: () => string;
}

export interface BuildIndexResult {
  index: CorpusIndex;
  stats: IndexRunStats;
}

const nowIso = (): string => new Date().toISOString();

function sha256Hex(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

/**
 * Derive a source label from the file's containing directory name (§2 schema:
 * fireflies | gemini | soundcore | unknown). Matches the real folder names
 * (Fireflies-Transcripts, Gemini-Transcripts, Soundcore-Transcripts) and is
 * tolerant of any path segment carrying the source word.
 */
export function sourceFromPath(path: string): IndexRecord["source"] {
  const lower = path.toLowerCase();
  if (lower.includes("soundcore")) return "soundcore";
  if (lower.includes("fireflies")) return "fireflies";
  if (lower.includes("gemini")) return "gemini";
  return "unknown";
}

/** Recursively collect .md/.txt files under the given paths (dotfiles skipped). */
export async function collectFiles(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  const walk = async (p: string): Promise<void> => {
    const info = await stat(p); // ENOENT surfaces — a bad input path is an error
    if (info.isDirectory()) {
      for (const entry of (await readdir(p)).sort()) {
        if (entry.startsWith(".")) continue;
        await walk(join(p, entry));
      }
      return;
    }
    if (TRANSCRIPT_EXTENSIONS.has(extname(p).toLowerCase())) files.push(p);
  };
  for (const p of paths) await walk(p);
  return [...new Set(files)].sort();
}

/** Build a single transcript's index record from its parsed form + raw bytes. */
export function buildRecord(
  transcript: Transcript,
  contentHash: string,
  indexedAt: string,
): IndexRecord {
  const speakerTurnCounts: Record<string, number> = {};
  for (const turn of transcript.turns) {
    if (!turn.speaker) continue;
    speakerTurnCounts[turn.speaker] = (speakerTurnCounts[turn.speaker] ?? 0) + 1;
  }
  const speakers = Object.entries(speakerTurnCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([s]) => s);

  // Empty transcripts carry no spoken content — skip the extractors entirely.
  const empty = transcript.empty === true;
  const { entities, terms } = empty
    ? { entities: [], terms: [] }
    : extractTranscriptTerms(transcript);
  const quantities: IndexQuantity[] = empty
    ? []
    : collectQuantityMentions(transcript).map((m) => ({
        kind: m.kind,
        value: m.value,
        speaker: m.speaker,
        timestamp: m.timestamp,
        context: m.context,
      }));

  return {
    path: transcript.path,
    source: sourceFromPath(transcript.path),
    title: transcript.title,
    date: transcript.date,
    speakers,
    speakerTurnCounts,
    turnCount: transcript.turns.length,
    duration: transcriptDuration(transcript),
    entities,
    terms,
    quantities,
    content_hash: contentHash,
    indexed_at: indexedAt,
    empty,
  };
}

/**
 * Build (or incrementally refresh) the corpus index. Pure function over the
 * filesystem reads it does: deterministic given the same files + previous
 * index (modulo timestamps, which are injectable for tests).
 *
 * Never throws on a bad transcript file: a parse/read error becomes a warning
 * and the file keeps its PRIOR record if one exists (matching
 * priorArtifactIndex's never-throw stance, §2).
 */
export async function buildIndex(opts: BuildIndexOptions): Promise<BuildIndexResult> {
  const now = opts.now ?? nowIso;
  const generatedAt = now();
  const prevByPath = new Map<string, IndexRecord>(
    (opts.previous?.transcripts ?? []).map((r) => [r.path, r]),
  );

  const files = await collectFiles(opts.inputs);
  const records: IndexRecord[] = [];
  const warnings: string[] = [];
  const stats: IndexRunStats = {
    total: 0,
    reprocessed: 0,
    unchanged: 0,
    added: 0,
    pruned: 0,
    empty: 0,
    warnings: 0,
  };

  for (const file of files) {
    const prev = prevByPath.get(file);
    let raw: Uint8Array;
    try {
      raw = await readFile(file);
    } catch (e) {
      // Unreadable file: keep its prior record if any, else just warn.
      warnings.push(
        `${file}: read error — ${(e as Error).message}` +
          (prev ? " — kept previous record" : " — skipped"),
      );
      if (prev) records.push(prev);
      continue;
    }
    const hash = `sha256:${sha256Hex(raw)}`;

    if (!opts.full && prev && prev.content_hash === hash) {
      records.push(prev); // unchanged — load from index, do NOT re-parse
      stats.unchanged++;
      continue;
    }

    try {
      const transcript = parseTranscript(raw.toString(), file);
      records.push(buildRecord(transcript, hash, generatedAt));
      stats.reprocessed++;
      if (!prev) stats.added++;
    } catch (e) {
      warnings.push(
        `${file}: parse error — ${(e as Error).message}` +
          (prev ? " — kept previous record" : " — skipped"),
      );
      if (prev) records.push(prev);
    }
  }

  // Without --prune, carry forward prior records for files NOT in this run's
  // input set (e.g. a narrower input scope shouldn't silently drop the rest).
  // With --prune, only records whose file still exists on disk survive.
  const seen = new Set(files);
  for (const [path, rec] of prevByPath) {
    if (seen.has(path)) continue;
    if (opts.prune) {
      try {
        await stat(path);
      } catch {
        stats.pruned++;
        continue; // file vanished — drop it
      }
    }
    records.push(rec);
  }

  records.sort((a, b) => a.path.localeCompare(b.path));
  stats.total = records.length;
  stats.empty = records.filter((r) => r.empty).length;
  stats.warnings = warnings.length;

  const index: CorpusIndex = {
    version: INDEX_VERSION,
    generated_at: generatedAt,
    transcript_dirs: opts.inputs,
    transcripts: records,
    warnings,
  };
  return { index, stats };
}

/** Read an existing index, or undefined if it's absent/unreadable/malformed. */
export async function readIndex(path: string): Promise<CorpusIndex | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CorpusIndex;
    if (parsed && Array.isArray(parsed.transcripts)) return parsed;
  } catch {
    // Missing or corrupt index → a full rebuild (caller treats as no previous).
  }
  return undefined;
}

/** Write the index atomically (tmp + rename), the feed/src/app.ts pattern. */
export async function writeIndex(path: string, index: CorpusIndex): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(index, null, 2) + "\n");
  await rename(tmp, path);
}

/**
 * Resolve the input dirs/files (§2 resolution order): positional args win;
 * else split $TRANSCRIPT_DIRS on commas; else throw listing every source
 * checked (mirrors getSecret's error-listing stance). Returns the inputs.
 */
export function resolveInputs(positional: string[], env = process.env): string[] {
  if (positional.length > 0) return positional;
  const dirs = (env.TRANSCRIPT_DIRS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (dirs.length > 0) return dirs;
  throw new Error(
    "No transcript inputs. Resolution order (in order):\n" +
      "  - positional <dir-or-file> args on the command line\n" +
      "  - $TRANSCRIPT_DIRS (comma-separated absolute dirs)\n" +
      "Fix: pass paths, or export TRANSCRIPT_DIRS=/abs/dir1,/abs/dir2 " +
      "(NOTHING is hardcoded — same rule as getSecret/the base SPEC).",
  );
}
