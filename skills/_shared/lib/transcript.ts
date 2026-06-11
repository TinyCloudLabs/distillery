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
//   E. Soundcore markdown (its own dialect — see parseSoundcore):
//        # Title
//        **Date:** … / **Duration:** …
//        ## Summary  (a WH-question prose block: **What**: / **Who**: …,
//                     organized under ## <Topic> / ### <Subtopic> headings,
//                     "## Summary" often appears twice)
//        ## Transcript                  ← the REAL diarized turns start here
//        **speaker1:**                   ← block-form: label ALONE on its line…
//        <turn text on the FOLLOWING line(s)>   ← …text on the next line(s)
//      Empty Soundcore recordings carry a "_(No transcript segments
//      available.)_" placeholder and must yield ZERO turns + empty=true.

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
  /**
   * True when the file carries no actual diarized content — e.g. a Soundcore
   * recording whose body is just the "_(No transcript segments available.)_"
   * placeholder. Empty transcripts emit `turns: []` (never a garbage
   * metadata-as-text turn). Downstream (index-corpus, query-corpus,
   * generation) skips these. Absent/false on every transcript that has turns.
   */
  empty?: boolean;
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
// "Samuel Gbafa: hey" / "[00:12] Samuel: hey" / "Speaker 2: hey" — plain
// diarized marker. The label must look like a NAME, not prose: at most 3
// words, the first capitalized, the rest capitalized or numeric (diarizers
// emit "Speaker 1"). Apostrophes (O'Brien), hyphens (Mary-Jane), and
// periods (Dr.) are allowed inside words. This deliberately rejects prose
// lines containing a colon — "Same root cause: deploys flush the cache."
// must stay attached to the preceding turn, not become a phantom speaker.
const NAME_WORD = String.raw`[A-Z][\w.'’-]*`;
const PLAIN_TURN_RE = new RegExp(
  String.raw`^(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?(${NAME_WORD}(?:\s+(?:${NAME_WORD}|\d+)){0,2}):\s+(.*)$`,
);
// "**Date:** 2026-05-12" — header metadata line.
const META_LINE_RE = /^\*\*([A-Za-z ]+):\*\*\s*(.*)$/;

// Soundcore "no content" placeholder — the empty-recording sentinel.
const SOUNDCORE_EMPTY_RE = /_\(No transcript segments available\.\)_/;
// "## Transcript" heading (the turn region opens here in Fireflies/Soundcore).
const TRANSCRIPT_HEADING_RE = /^##\s+Transcript\s*$/m;
// Soundcore WH-summary signature: bold WH-question labels with the colon
// OUTSIDE the bold ("**What**: …"), or "**Related Personnel**: …". These are
// the prose lines §4 warns must never become phantom speaker turns. Note this
// is a DIFFERENT shape from META_LINE_RE ("**Key:**", colon inside).
const SOUNDCORE_WH_RE =
  /^\*\*(What|Who|When|Where|Why|How|Time|Location|Related Personnel)\*\*\s*:/m;
// "**speaker1:**" alone on its own line — Soundcore's block-form turn marker.
const SOUNDCORE_TURN_LABEL_RE = /^\*\*([^*\n]+?)\s*:\s*\*\*\s*$/;
// A bold inline label ("**Note:** …") only opens a NEW turn mid-region (i.e.
// when a turn is already open) if its label is distinctly speaker-shaped:
//   - a Soundcore generic diarizer label ("speaker1", "speaker12"), OR
//   - a multi-token name ("Tina (Flashbots)", "Samuel Gbafa") — first word
//     capitalized, then more name words / numbers / a parenthetical.
// A bare single capitalized word ("Note", "Action", "Summary") is bold
// EMPHASIS, not a speaker — it stays in the open turn's body. (When NO turn is
// open yet, the first inline label always opens the turn regardless of shape.)
const SPEAKER_LIKE_LABEL_RE = new RegExp(
  String.raw`^(?:speaker\d+|${NAME_WORD}(?:\s+(?:${NAME_WORD}|\d+|\([^)]*\)))+|${NAME_WORD}\s*\([^)]*\))$`,
  "i",
);
function looksLikeSpeakerLabel(label: string): boolean {
  return SPEAKER_LIKE_LABEL_RE.test(label.trim());
}

/**
 * Soundcore detection: the raw text has a "## Transcript" heading AND the body
 * before it carries the WH-summary signature (the WH-question bold lines, or a
 * duplicated "## Summary"). Cheap regex sniff — when unsure we fall through to
 * generic parsing, so a false negative just means the generic path handles it
 * (which it already does for this corpus, by accident of the gate). A false
 * positive is harmless: parseSoundcore is a stricter, turn-region-scoped
 * version of the same logic.
 */
function isSoundcore(raw: string): boolean {
  const headingMatch = TRANSCRIPT_HEADING_RE.exec(raw);
  if (!headingMatch) return false;
  const beforeTranscript = raw.slice(0, headingMatch.index);
  if (SOUNDCORE_WH_RE.test(beforeTranscript)) return true;
  // Duplicated "## Summary" before the transcript is the other tell.
  const summaryHeadings = beforeTranscript.match(/^##\s+Summary\s*$/gm);
  return (summaryHeadings?.length ?? 0) >= 2;
}

/**
 * True when the Soundcore "no segments" placeholder is the SOLE content under
 * the (FIRST) `## Transcript` heading — i.e. the recording is genuinely empty.
 * Returns false when real turn content sits alongside the sentinel (a quote, a
 * concatenation), so a real transcript is never wiped to zero turns by a raw
 * substring match. When there is no `## Transcript` heading at all, returns
 * false (we let the normal parsers run; they self-flag empty on zero turns).
 */
function soundcorePlaceholderIsSoleContent(raw: string): boolean {
  const heading = TRANSCRIPT_HEADING_RE.exec(raw);
  if (!heading) return false;
  const region = raw.slice(heading.index + heading[0].length);
  // Strip every occurrence of the sentinel; if nothing non-whitespace remains,
  // the placeholder is the only thing under ## Transcript.
  const stripped = region.replace(new RegExp(SOUNDCORE_EMPTY_RE.source, "g"), "").trim();
  return stripped === "";
}

export function parseTranscript(raw: string, path = ""): Transcript {
  // Empty detection (all formats, cheap + high-value): a body whose only
  // diarized content is the Soundcore "no segments" placeholder yields ZERO
  // turns + empty=true, never the metadata-as-text garbage turn the plain-text
  // fallback would otherwise produce. (§4 bug 1.)
  //
  // Guard against a raw-substring false positive: a real transcript that merely
  // CONTAINS the sentinel string (concatenation, a turn quoting the placeholder,
  // a multi-segment export) must NOT be wiped to zero turns. We only flag empty
  // when the sentinel is the SOLE content under ## Transcript — see
  // soundcorePlaceholderIsSoleContent. (If no ## Transcript region, fall through
  // to normal parsing; the downstream parsers self-flag empty when zero real
  // turns survive.)
  if (SOUNDCORE_EMPTY_RE.test(raw) && soundcorePlaceholderIsSoleContent(raw)) {
    const t: Transcript = { path, turns: [], raw, empty: true };
    annotateHeaderMeta(t, raw);
    return t;
  }

  // Soundcore dialect: route the WH-summary prose out of turns and scope the
  // block-form **speaker:** turns to the post-"## Transcript" region. (§4.)
  if (isSoundcore(raw)) return parseSoundcore(raw, path);

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
  let sawBoldTurn = false;

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
        sawBoldTurn = true;
        turnLines.push({
          speaker: bold[1].trim(),
          timestamp: bold[2],
          lines: bold[3] ? [bold[3]] : [],
        });
        continue;
      }
      // Format dominance: files that mark turns in bold (Fireflies /
      // Gemini-sync) never mix in plain "Name: text" markers, so once a
      // bold turn has been seen, a name-like colon line ("Plan B: ship
      // Friday.") is prose inside the current turn, not a speaker change.
      const plain = sawBoldTurn ? null : PLAIN_TURN_RE.exec(line);
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

/**
 * Soundcore adapter (§4). Soundcore `.md` is block-form: a WH-question summary
 * (**What**: / **Who**: prose under ## <Topic> / ### <Subtopic> headings) sits
 * ABOVE the real diarized turns, which only begin at "## Transcript" — often
 * far down the file. Turns are "**speaker:**" alone on a line, with the text on
 * the FOLLOWING line(s), blank-line separated.
 *
 * Two hardenings over the generic path:
 *   1. Everything before the FIRST "## Transcript" heading is non-turn material
 *      (the WH prose routes into `summary`, never into turns). This makes the
 *      "**What**:" bold lines unreachable as phantom speakers regardless of
 *      where they sit. Splitting on the FIRST heading (not the last) means a
 *      file with a duplicated "## Transcript" heading keeps the turns under the
 *      earlier region instead of silently dropping them.
 *   2. The block-form turn region is parsed explicitly: a "**speaker:**"-alone
 *      line opens a turn; subsequent non-label lines are its body.
 * Generic speaker labels (speaker1, speaker2) are kept as-is; human-named
 * labels (Sam, Hunter, "Tina (Flashbots)") are kept verbatim.
 */
function parseSoundcore(raw: string, path: string): Transcript {
  const t: Transcript = { path, turns: [], raw };
  annotateHeaderMeta(t, raw);

  // Split on the FIRST "## Transcript" heading: everything above is summary
  // prose, everything below (including any later duplicate "## Transcript"
  // heading) is the turn region. Splitting on the first heading keeps turns
  // under an earlier region instead of dropping them when the heading repeats.
  const lines = raw.split("\n");
  let firstTranscriptIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Transcript\s*$/.test(lines[i]!)) {
      firstTranscriptIdx = i;
      break;
    }
  }

  if (firstTranscriptIdx === -1) {
    // No transcript heading found (shouldn't happen — isSoundcore gates on it).
    // Fall back to generic parsing to avoid losing content.
    return parseTranscriptGeneric(raw, path);
  }

  // Summary = the WH prose between the header and the transcript region.
  // Capture it verbatim (minus the title/metadata header lines) so downstream
  // still has the pre-written summary if it wants it.
  const summaryLines = lines.slice(0, firstTranscriptIdx);
  const summary = summaryLines
    .filter((l) => !/^#\s/.test(l) && !META_LINE_RE.test(l))
    .join("\n")
    .trim();
  if (summary) t.summary = summary;

  // Turn region: block-form **speaker:** lines + following body lines. A later
  // duplicate "## Transcript" heading inside this region is skipped (not a turn).
  const turnLines: { speaker: string; lines: string[] }[] = [];
  for (let i = firstTranscriptIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // A later duplicate "## Transcript" heading inside this region is structure,
    // not a turn — skip it (its turns already merge into this same region).
    if (/^##\s+Transcript\s*$/.test(line)) continue;
    const label = SOUNDCORE_TURN_LABEL_RE.exec(line);
    if (label?.[1] !== undefined) {
      turnLines.push({ speaker: label[1].trim(), lines: [] });
      continue;
    }
    // An inline "**speaker:** text" form (label + text on one line) is also
    // valid Soundcore turn shape — handle it via the generic BOLD_TURN_RE. But
    // guard against greediness: a body line that merely STARTS with bold
    // emphasis ("**Note:** the rest of the thought") must NOT steal the open
    // turn. Open a new turn only when there's no open turn yet, OR the label is
    // distinctly speaker-shaped (looksLikeSpeakerLabel) — mirroring the generic
    // parser's format-dominance guard. Otherwise the line is body.
    const inline = BOLD_TURN_RE.exec(line);
    if (inline?.[1] !== undefined && line.trimStart().startsWith("**")) {
      const speakerName = inline[1].trim();
      if (turnLines.length === 0 || looksLikeSpeakerLabel(speakerName)) {
        turnLines.push({
          speaker: speakerName,
          lines: inline[3] ? [inline[3]] : [],
        });
        continue;
      }
      // Mid-turn bold emphasis → falls through to body append below.
    }
    if (turnLines.length > 0) {
      turnLines[turnLines.length - 1]!.lines.push(line);
    }
    // Lines before the first speaker label in the turn region are dropped
    // (stray blank lines / placeholder artifacts), matching the generic path's
    // "no current turn → not body" behavior.
  }

  for (const tl of turnLines) {
    const text = tl.lines.join("\n").trim();
    if (!text) continue;
    t.turns.push({ speaker: tl.speaker, text });
  }

  // Defensive empty-flag: a Soundcore file with a transcript heading but no
  // real turns is effectively empty (the §4 empty-check already catches the
  // placeholder sentinel, but this covers a heading with nothing under it).
  if (t.turns.length === 0) t.empty = true;

  return t;
}

/**
 * Re-run the generic parser but discard any turns/summary — used only to lift
 * the title/date/duration/participants header off a Soundcore file (and as a
 * safety fallback). Kept separate so parseSoundcore never recurses into the
 * Soundcore branch.
 */
function parseTranscriptGeneric(raw: string, path: string): Transcript {
  // Strip the empty-sentinel + Soundcore signature so parseTranscript takes
  // the generic branch. Only the metadata header is reused by the caller.
  const t: Transcript = { path, turns: [], raw };
  annotateHeaderMeta(t, raw);
  return t;
}

/**
 * Lift the leading "# Title" + "**Date:** / **Duration:** / **Participants:**"
 * header off a raw body into a Transcript, without parsing any turns. Used by
 * the empty path and the Soundcore path so an empty/Soundcore file still
 * carries its title/date for the index. Only scans the preamble before the
 * first "##" heading.
 */
function annotateHeaderMeta(t: Transcript, raw: string): void {
  for (const line of raw.split("\n")) {
    if (/^##\s/.test(line)) break; // header ends at the first section heading
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1?.[1] !== undefined && t.title === undefined) {
      t.title = h1[1].trim();
      continue;
    }
    const meta = META_LINE_RE.exec(line);
    if (meta?.[1] !== undefined) applyMeta(t, meta[1], meta[2] ?? "");
  }
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
 * Best-available duration string for a transcript. Fireflies sometimes emits
 * a broken "**Duration:** 0 min" header even for hour-long meetings, so when
 * the parsed turns carry timestamps we compute the span from the first to the
 * last stamped turn and trust THAT; the header value is only a fallback.
 * Returns e.g. "62 min" (rounded, min 1), or the header string, or undefined.
 *
 * Timestamp convention: "HH:MM:SS" or "MM:SS" (two-part stamps are
 * minutes:seconds, matching Fireflies/diarizer output).
 */
export function transcriptDuration(transcript: Transcript): string | undefined {
  const stamps = transcript.turns
    .map((turn) => turn.timestamp)
    .filter((s): s is string => s !== undefined)
    .map(timestampToSeconds)
    .filter((s): s is number => s !== undefined);
  if (stamps.length >= 2) {
    const span = stamps[stamps.length - 1]! - stamps[0]!;
    if (span > 0) return `${Math.max(1, Math.round(span / 60))} min`;
  }
  return transcript.duration;
}

function timestampToSeconds(stamp: string): number | undefined {
  const parts = stamp.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return undefined;
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
 *
 * Matches against parsed speaker-segment text when segments exist — NOT the
 * raw file, which can carry AI-generated Summary / Action Items headers
 * (Fireflies) that were never actually spoken. Only the plain-text fallback
 * (no speaker structure found) verifies against the raw content.
 */
export function verifyQuote(transcript: Transcript, quote: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const needle = normalize(quote);
  if (!needle) return false;
  // An empty transcript has no spoken content — never verify a quote against
  // its metadata-only raw body.
  if (transcript.empty) return false;
  const hasSegments = transcript.turns.some((turn) => turn.speaker !== undefined);
  const haystack = hasSegments
    ? transcript.turns.map((turn) => turn.text).join("\n")
    : transcript.raw;
  return normalize(haystack).includes(needle);
}

export interface QuoteTurnMatch {
  /** Index into transcript.turns of the first matching turn. */
  index: number;
  turn: TranscriptTurn;
}

/**
 * Locate the first speaker turn whose text contains the quote, using the
 * same whitespace-insensitive matching as verifyQuote. Returns null when no
 * single turn contains it. A quote can still pass verifyQuote while this
 * returns null when it spans adjacent turns — callers should treat
 * (verifyQuote=true, findQuoteTurn=null) as "present, but spans turns".
 *
 * Note: a turn match proves the words were spoken, not who spoke them —
 * diarization speaker labels can be wrong.
 */
export function findQuoteTurn(transcript: Transcript, quote: string): QuoteTurnMatch | null {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const needle = normalize(quote);
  if (!needle) return null;
  for (const [index, turn] of transcript.turns.entries()) {
    if (normalize(turn.text).includes(needle)) return { index, turn };
  }
  return null;
}
