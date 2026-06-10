// Transcript parsing for distillery skills.
//
// Source-agnostic input contract v1: skills consume plain transcript files
// (.md / .txt) from paths passed at invocation time. Nothing here knows
// about any particular machine, folder layout, or backend. A future
// Listen-backed source (transcript multiplexer in TinyCloud) slots in as
// another producer of the same Transcript shape — see loadTranscripts.
//
// Formats handled:
//   A. Fireflies / Gemini-sync markdown:
//        # Title
//        **Date:** 2026-05-12
//        **Duration:** 2 min
//        **Participants:** a@x.com, b@y.com
//        ## Summary ...        (optional)
//        ## Action Items ...   (optional)
//        ## Transcript
//        **Speaker Name:**     (turn marker; may carry a (HH:MM[:SS]) stamp)
//        text...
//   B. Markdown with YAML frontmatter (--- title/date/source ---) over the
//      same speaker-turn body.
//   C. Bare diarized markdown (VoxTerm style): speaker turns with no header.
//   D. Plain text fallback: whole body becomes one unattributed turn.

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export interface TranscriptTurn {
  speaker?: string;
  /** Raw timestamp string as it appeared, e.g. "01:29:10" or "25:47". */
  timestamp?: string;
  text: string;
}

export interface Transcript {
  /** Absolute or as-given path of the source file ("" when parsed from a string). */
  path: string;
  title?: string;
  date?: string;
  source?: string;
  participants?: string[];
  duration?: string;
  /** Pre-written sections (Fireflies emits these); verbatim markdown. */
  summary?: string;
  actionItems?: string;
  turns: TranscriptTurn[];
  /** Full original file content, for exact-quote verification. */
  raw: string;
}

export interface TranscriptChunk {
  /** Path of the transcript this chunk came from. */
  transcript: string;
  index: number;
  speakers: string[];
  text: string;
}

const TRANSCRIPT_EXTENSIONS = new Set([".md", ".txt"]);

// "**Samuel Gbafa:**" / "**Samuel Gbafa (01:29:10):**" — bold speaker marker.
const BOLD_TURN_RE = /^\*\*([^*\n]+?)(?:\s*\((\d{1,2}:\d{2}(?::\d{2})?)\))?\s*:\s*\*\*\s*(.*)$/;
// "Samuel Gbafa: hey" / "[00:12] Samuel: hey" — plain diarized marker.
const PLAIN_TURN_RE = /^(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?([A-Z][\w.'-]*(?:\s+[\w.'-]+){0,4}):\s+(.*)$/;
// "**Date:** 2026-05-12" — header metadata line.
const META_LINE_RE = /^\*\*([A-Za-z ]+):\*\*\s*(.*)$/;

export function parseTranscript(raw: string, path = ""): Transcript {
  const t: Transcript = { path, turns: [], raw };
  let body = raw;

  // YAML frontmatter (simple key: value pairs only — enough for
  // title/date/source; we deliberately don't pull in a YAML parser).
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (fm?.[1] !== undefined) {
    for (const line of fm[1].split("\n")) {
      const m = /^([A-Za-z_ -]+):\s*(.*)$/.exec(line);
      if (!m || m[1] === undefined || m[2] === undefined) continue;
      applyMeta(t, m[1], stripQuotes(m[2]));
    }
    body = body.slice(fm[0].length);
  }

  const lines = body.split("\n");
  let section = ""; // current "## Heading" (lowercased), "" = preamble
  const sectionText: Record<string, string[]> = {};
  const turnLines: { speaker?: string; timestamp?: string; lines: string[] }[] = [];
  let sawTranscriptHeading = false;

  const inTurnRegion = () =>
    !sawTranscriptHeading || section === "transcript";

  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1?.[1] !== undefined && t.title === undefined) {
      t.title = h1[1].trim();
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2?.[1] !== undefined) {
      section = h2[1].trim().toLowerCase();
      if (section === "transcript") sawTranscriptHeading = true;
      continue;
    }

    const meta = META_LINE_RE.exec(line);
    if (meta?.[1] !== undefined && section === "" && turnLines.length === 0) {
      // Header metadata only counts before any speaker turns; after that,
      // **Name:** lines are turn markers.
      const looksLikeMeta = applyMeta(t, meta[1], meta[2] ?? "");
      if (looksLikeMeta) continue;
    }

    if (inTurnRegion()) {
      const bold = BOLD_TURN_RE.exec(line);
      if (bold?.[1] !== undefined) {
        turnLines.push({
          speaker: bold[1].trim(),
          timestamp: bold[2],
          lines: bold[3] ? [bold[3]] : [],
        });
        continue;
      }
      const plain = PLAIN_TURN_RE.exec(line);
      if (plain?.[2] !== undefined && plain[3] !== undefined) {
        turnLines.push({
          speaker: plain[2].trim(),
          timestamp: plain[1],
          lines: [plain[3]],
        });
        continue;
      }
      if (turnLines.length > 0) {
        turnLines[turnLines.length - 1]!.lines.push(line);
        continue;
      }
    }

    (sectionText[section] ??= []).push(line);
  }

  if (sectionText["summary"]) t.summary = sectionText["summary"].join("\n").trim() || undefined;
  if (sectionText["action items"])
    t.actionItems = sectionText["action items"].join("\n").trim() || undefined;

  for (const tl of turnLines) {
    const text = tl.lines.join("\n").trim();
    if (!text) continue;
    t.turns.push({ speaker: tl.speaker, timestamp: tl.timestamp, text });
  }

  // Plain-text fallback: no speaker structure found → one unattributed turn.
  if (t.turns.length === 0) {
    const fallback = (sectionText[""] ?? []).join("\n").trim() || body.trim();
    if (fallback) t.turns.push({ text: fallback });
  }

  return t;
}

function applyMeta(t: Transcript, key: string, value: string): boolean {
  const v = value.trim();
  switch (key.trim().toLowerCase()) {
    case "title":
      t.title ??= v || undefined;
      return true;
    case "date":
      t.date = v || undefined;
      return true;
    case "source":
      t.source = v || undefined;
      return true;
    case "duration":
      t.duration = v || undefined;
      return true;
    case "participants":
      t.participants = v ? v.split(",").map((p) => p.trim()).filter(Boolean) : undefined;
      return true;
    default:
      return false;
  }
}

function stripQuotes(s: string): string {
  const t = s.trim();
  return /^".*"$/.test(t) || /^'.*'$/.test(t) ? t.slice(1, -1) : t;
}

/**
 * Load transcripts from a mix of file and directory paths (directories are
 * walked recursively; only .md/.txt files are picked up). This is the v1
 * input boundary: a future Listen adapter replaces "paths on disk" with
 * "transcripts from TinyCloud" by producing the same Transcript[].
 */
export async function loadTranscripts(paths: string[]): Promise<Transcript[]> {
  const files: string[] = [];
  for (const p of paths) {
    await collectFiles(p, files);
  }
  files.sort();
  const out: Transcript[] = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    out.push(parseTranscript(raw, file));
  }
  return out;
}

async function collectFiles(path: string, into: string[]): Promise<void> {
  const info = await stat(path); // throws ENOENT for bad paths — let it surface
  if (info.isDirectory()) {
    const entries = await readdir(path);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      await collectFiles(join(path, entry), into);
    }
    return;
  }
  if (TRANSCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) into.push(path);
}

/**
 * Group consecutive turns into chunks of at most maxChars (one oversize turn
 * still becomes its own chunk). Deterministic plumbing for skills that hand
 * chunks to an agent for judgment.
 */
export function chunkTranscript(
  transcript: Transcript,
  maxChars = 8000,
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let buf: string[] = [];
  let speakers = new Set<string>();
  let size = 0;

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push({
      transcript: transcript.path || basename(transcript.path || "") || "(in-memory)",
      index: chunks.length,
      speakers: [...speakers],
      text: buf.join("\n\n"),
    });
    buf = [];
    speakers = new Set();
    size = 0;
  };

  for (const turn of transcript.turns) {
    const rendered = turn.speaker
      ? `${turn.speaker}${turn.timestamp ? ` (${turn.timestamp})` : ""}: ${turn.text}`
      : turn.text;
    if (size > 0 && size + rendered.length > maxChars) flush();
    buf.push(rendered);
    if (turn.speaker) speakers.add(turn.speaker);
    size += rendered.length + 2;
  }
  flush();
  return chunks;
}

/**
 * Verify a quote appears in a transcript, whitespace-insensitively.
 * The quality loop's deterministic half: agents propose quotes, this proves
 * they exist verbatim in the source.
 */
export function verifyQuote(transcript: Transcript, quote: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const needle = normalize(quote);
  if (!needle) return false;
  return normalize(transcript.raw).includes(needle);
}
