// listen-read-lib.ts — read curated Listen conversations + transcripts from
// TinyCloud and write them to a local corpus dir the distillery generation
// skills consume (they take transcript paths at invocation).
//
// Listen is a manifest app (app_id xyz.tinycloud.listen). Its canonical data
// lives in the OWNER's `applications` space:
//   - conversations (SQL): --db xyz.tinycloud.listen/conversations  → tables
//     `conversation`, `participant`.
//   - transcripts (KV, importer path): xyz.tinycloud.listen/transcript/<conversationId>
//     → JSON array of { index, speaker_id, speaker_name, text, start_time, … }.
//   - transcripts (Listen app path): inline `conversation.transcript_json` or
//     `conversation.transcript_text` columns when the app stores normalized
//     Fireflies rows directly in SQL.
//
// Access model (§3.4): the agent runs the real read; on AUTH_UNAUTHORIZED the
// caller drives the delegate-asks-owner handshake (request → owner grant →
// import → retry). For V1 the agent MAY be the owner of the Listen space
// (self-grant), but this lib never assumes that — it only reads and lets the
// TcCliError surface so the skill's remediation path runs. No fallback to fake
// data, no swallowing of a missing-cap error.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  kvList,
  sqlQuery,
  tcJson,
  TcCliError,
  type TcRunOptions,
} from "../../_shared/lib/tc.ts";
import { slugify } from "../../_shared/lib/artifact.ts";

const LISTEN_CONVERSATIONS_DB = "xyz.tinycloud.listen/conversations";
const TRANSCRIPT_PREFIX = "xyz.tinycloud.listen/transcript";

// The two caps the Listen reader needs (§3.3 grant #1). SQL actions are
// `read`; KV actions are `get,list,metadata` (NOT read); KV prefix caps need a
// TRAILING SLASH. These are the exact specs the owner grants.
export const LISTEN_SQL_PATH = "xyz.tinycloud.listen/conversations";
export const LISTEN_KV_PREFIX = "xyz.tinycloud.listen/"; // trailing slash load-bearing

/**
 * Build the two cap specs Listen-read needs, scoped to the Listen owner's
 * space. `ownerSpace` is the owner's applications space — a bare name resolves
 * to YOUR space, so for a cross-identity request pass the owner's full URI
 * (tinycloud:pkh:eip155:1:<owner-addr>:applications).
 */
export function listenReadCaps(ownerSpace: string): string[] {
  return [
    `tinycloud.sql:${ownerSpace}:${LISTEN_SQL_PATH}:read`,
    `tinycloud.kv:${ownerSpace}:${LISTEN_KV_PREFIX}:get,list,metadata`,
  ];
}

export interface ListenTarget {
  /** --space name or URI of the Listen OWNER's applications space. */
  space?: string;
}

export interface ConversationMeta {
  id: string;
  title: string;
  /** ISO-ish start time if the row carries one (display only). */
  started_at?: string;
  /** Inline transcript JSON used by the Listen app for some synced sources. */
  transcript_json?: string;
  /** Plain transcript text fallback used by the Listen app for some sources. */
  transcript_text?: string;
}

/** One spoken turn in a Listen transcript (the KV JSON array element shape). */
export interface TranscriptTurn {
  index: number;
  speaker_id?: string;
  speaker_name?: string;
  text: string;
  start_time?: number;
  end_time?: number;
  language?: string;
}

function optionalString(row: unknown[], columnIndex: number | undefined): string | undefined {
  if (columnIndex === undefined) return undefined;
  const value = row[columnIndex];
  if (value == null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function asTranscriptTurn(value: unknown, index: number): TranscriptTurn | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const text =
    typeof record.text === "string"
      ? record.text
      : typeof record.content === "string"
        ? record.content
        : typeof record.transcript === "string"
          ? record.transcript
          : "";
  if (!text.trim()) return undefined;
  const speaker =
    typeof record.speaker_name === "string"
      ? record.speaker_name
      : typeof record.speakerName === "string"
        ? record.speakerName
        : typeof record.speaker === "string"
          ? record.speaker
          : undefined;
  return {
    index:
      typeof record.index === "number"
        ? record.index
        : typeof record.idx === "number"
          ? record.idx
          : index,
    speaker_id:
      typeof record.speaker_id === "string"
        ? record.speaker_id
        : typeof record.speakerId === "string"
          ? record.speakerId
          : undefined,
    speaker_name: speaker,
    text,
    start_time:
      typeof record.start_time === "number"
        ? record.start_time
        : typeof record.startTime === "number"
          ? record.startTime
          : undefined,
    end_time:
      typeof record.end_time === "number"
        ? record.end_time
        : typeof record.endTime === "number"
          ? record.endTime
          : undefined,
    language: typeof record.language === "string" ? record.language : undefined,
  };
}

function transcriptTurnsFromJsonValue(value: unknown): TranscriptTurn[] {
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => asTranscriptTurn(entry, index))
      .filter((turn): turn is TranscriptTurn => Boolean(turn));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["turns", "segments", "utterances", "transcript"]) {
      const turns = transcriptTurnsFromJsonValue(record[key]);
      if (turns.length > 0) return turns;
    }
  }
  return [];
}

export function transcriptTurnsFromInline(meta: ConversationMeta): TranscriptTurn[] {
  if (meta.transcript_json) {
    try {
      const parsed = JSON.parse(meta.transcript_json);
      const turns = transcriptTurnsFromJsonValue(parsed);
      if (turns.length > 0) return turns;
    } catch {
      // Fall through to transcript_text. The SQL row can carry both.
    }
  }
  if (meta.transcript_text?.trim()) {
    return [
      {
        index: 0,
        speaker_name: "Transcript",
        text: meta.transcript_text,
      },
    ];
  }
  return [];
}

/**
 * List recent conversations, most-recent first. Selects a resilient column set:
 * `id`, a title-ish column, and a start-time-ish column if present. The Listen
 * schema's exact column names vary by importer, so we read `*` and pick.
 */
export async function listConversations(
  limit: number,
  target: ListenTarget,
  opts: TcRunOptions = {},
): Promise<ConversationMeta[]> {
  const res = await sqlQuery(
    `SELECT * FROM conversation ORDER BY rowid DESC LIMIT ?`,
    { db: LISTEN_CONVERSATIONS_DB, space: target.space },
    [limit],
    opts,
  );
  const col = (name: string) => res.columns.indexOf(name);
  const idCol = col("id");
  // Title may be under several names depending on importer.
  const titleCol = ["title", "name", "subject", "summary"]
    .map(col)
    .find((c) => c >= 0);
  const startCol = ["started_at", "start_time", "date", "created_at"]
    .map(col)
    .find((c) => c >= 0);
  const transcriptJsonCol = [
    "transcript_json",
    "transcript",
    "segments_json",
    "utterances_json",
  ]
    .map(col)
    .find((c) => c >= 0);
  const transcriptTextCol = ["transcript_text", "transcript_plaintext"]
    .map(col)
    .find((c) => c >= 0);
  if (idCol < 0) {
    throw new Error(
      `conversation table has no 'id' column (columns: ${res.columns.join(", ")})`,
    );
  }
  return res.rows.map((row) => ({
    id: String(row[idCol]),
    title: optionalString(row, titleCol) ?? String(row[idCol]),
    started_at: optionalString(row, startCol),
    transcript_json: optionalString(row, transcriptJsonCol),
    transcript_text: optionalString(row, transcriptTextCol),
  }));
}

/**
 * Fetch a conversation's transcript from KV (the base64-suffixed value, decoded
 * to the JSON turn array). The transcript key has NO .b64 suffix on the Listen
 * side (it is stored as a JSON string), so we read it raw and JSON.parse.
 */
export async function fetchTranscript(
  conversationId: string,
  target: ListenTarget,
  opts: TcRunOptions = {},
): Promise<TranscriptTurn[]> {
  const key = `${TRANSCRIPT_PREFIX}/${conversationId}`;
  const argv = ["kv", "get", key, "--raw"];
  if (target.space) argv.push("--space", target.space);
  // kv get --raw returns the stored value; tcJson handles the {error} body.
  // The transcript value is a JSON array string.
  const value = await tcJson<unknown>(argv, opts);
  if (Array.isArray(value)) return value as TranscriptTurn[];
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error(`transcript ${key} is not a JSON array`);
    }
    return parsed as TranscriptTurn[];
  }
  throw new Error(`unexpected transcript value shape for ${key}`);
}

/** Render a turn array into a diarized markdown transcript the skills parse. */
export function renderTranscriptMarkdown(
  meta: ConversationMeta,
  turns: TranscriptTurn[],
): string {
  const lines: string[] = [];
  lines.push(`# ${meta.title}`);
  if (meta.started_at) lines.push(`**Date:** ${meta.started_at}`);
  lines.push(`**Source:** Listen conversation ${meta.id}`);
  lines.push("");
  lines.push("## Transcript");
  lines.push("");
  for (const turn of turns) {
    const speaker = turn.speaker_name || turn.speaker_id || "Speaker";
    lines.push(`**${speaker}:**`);
    lines.push(turn.text.trim());
    lines.push("");
  }
  return lines.join("\n");
}

export interface WrittenTranscript {
  conversationId: string;
  title: string;
  path: string;
  turnCount: number;
}

/**
 * Read `count` recent conversations + their transcripts and write each as a
 * markdown file into `corpusDir`. Returns what was written (for the fetch node
 * to hand transcript paths to the generation skills).
 */
export async function dumpCorpus(
  count: number,
  corpusDir: string,
  target: ListenTarget,
  opts: TcRunOptions = {},
): Promise<WrittenTranscript[]> {
  await mkdir(corpusDir, { recursive: true });
  // Different import paths store transcripts in different places. The importer
  // writes KV blobs, while the Listen app can store Fireflies rows inline in SQL
  // (`transcript_json` / `transcript_text`). List KV keys once so we can prefer
  // the blob when present and avoid blind-probing every row.
  const keyList = await kvList(`${TRANSCRIPT_PREFIX}/`, { space: target.space }, opts);
  const transcriptIds = new Set(
    keyList.keys.map((k) => k.slice(`${TRANSCRIPT_PREFIX}/`.length)),
  );
  // Scan a generous window of recent conversations (well above the current
  // table size) so the recency-first transcript-backed rows are all reachable
  // even as the conversation table grows; the intersection below is what bounds
  // the work, not this limit.
  const CONVERSATION_SCAN_LIMIT = 10_000;
  const conversations = await listConversations(CONVERSATION_SCAN_LIMIT, target, opts);
  const written: WrittenTranscript[] = [];
  for (const meta of conversations) {
    if (written.length >= count) break;
    let turns: TranscriptTurn[];
    if (transcriptIds.has(meta.id)) {
      try {
        turns = await fetchTranscript(meta.id, target, opts);
      } catch (e) {
        // A conversation whose transcript key vanished between list and get is
        // the same "nothing to distill" case as an empty transcript — skip it.
        // Any other tc error (auth, unhosted, malformed) still throws loudly.
        if (e instanceof TcCliError && e.code === "NOT_FOUND") continue;
        throw e;
      }
    } else {
      turns = transcriptTurnsFromInline(meta);
    }
    if (turns.length === 0) continue; // empty transcript — nothing to distill
    const md = renderTranscriptMarkdown(meta, turns);
    const fileName = `${slugify(meta.title)}-${meta.id.slice(0, 8)}.md`;
    const path = join(corpusDir, fileName);
    await writeFile(path, md);
    written.push({
      conversationId: meta.id,
      title: meta.title,
      path,
      turnCount: turns.length,
    });
  }
  return written;
}

// ---------------------------------------------------------------------------
// Delegate-asks-owner request emission (§3.4). Makes the OpenKey owner's grant
// a single command: the agent emits ONE request artifact carrying BOTH caps
// (--cap is repeatable), the owner runs ONE `tc auth grant`, the agent runs
// ONE `tc auth import` + `tc auth retry`. No server poll — the file is the
// hand-off medium.
// ---------------------------------------------------------------------------

export interface EmittedListenRequest {
  /** Absolute/given path of the emitted request artifact. */
  file: string;
  /** The two cap specs the request carries. */
  caps: string[];
  /** requestId from the emitted artifact (for `tc auth retry <id>`). */
  requestId?: string;
}

/**
 * Emit a single `tinycloud.auth.request` artifact requesting BOTH Listen-read
 * caps, scoped to the owner's space, to `file`. The owner grants it in their
 * (browser) session; the agent then imports + retries. Throws TcCliError if tc
 * rejects the request build (never on a network call — `auth request` without
 * `--grant` does not contact the node).
 */
export async function emitListenReadRequest(
  ownerSpace: string,
  file: string,
  opts: TcRunOptions = {},
): Promise<EmittedListenRequest> {
  const caps = listenReadCaps(ownerSpace);
  const argv = ["auth", "request"];
  for (const cap of caps) argv.push("--cap", cap);
  argv.push("--emit", file);
  const res = await tcJson<{ emitted?: boolean; requestId?: string }>(
    argv,
    opts,
  );
  return { file, caps, requestId: res.requestId };
}
