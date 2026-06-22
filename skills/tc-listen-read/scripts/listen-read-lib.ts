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
  /** True when the row appears to carry an inline SQL transcript payload. */
  has_inline_transcript?: boolean;
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

function optionalBool(row: unknown[], columnIndex: number | undefined): boolean | undefined {
  if (columnIndex === undefined) return undefined;
  const value = row[columnIndex];
  if (value == null) return undefined;
  return value === true || value === 1 || value === "1";
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

const TITLE_COLUMNS = ["title", "name", "subject", "summary"] as const;
const START_COLUMNS = ["started_at", "start_time", "date", "created_at"] as const;
const INLINE_JSON_COLUMNS = ["transcript_json", "transcript", "segments_json", "utterances_json"] as const;
const INLINE_TEXT_COLUMNS = ["transcript_text", "transcript_plaintext"] as const;

export interface ConversationColumnMap {
  id: string;
  title?: string;
  startedAt?: string;
  transcriptJson?: string;
  transcriptText?: string;
}

function sqlIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL column name: ${name}`);
  }
  return `"${name}"`;
}

export function mapConversationColumns(columns: readonly string[]): ConversationColumnMap {
  if (!columns.includes("id")) {
    throw new Error(`conversation table has no 'id' column (columns: ${columns.join(", ")})`);
  }
  return {
    id: "id",
    title: TITLE_COLUMNS.find((name) => columns.includes(name)),
    startedAt: START_COLUMNS.find((name) => columns.includes(name)),
    transcriptJson: INLINE_JSON_COLUMNS.find((name) => columns.includes(name)),
    transcriptText: INLINE_TEXT_COLUMNS.find((name) => columns.includes(name)),
  };
}

function missingColumn(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /no such column|unknown column/i.test(message);
}

export function conversationListSql(columns: ConversationColumnMap): string {
  const id = sqlIdent(columns.id);
  const selected = [
    `${id} AS id`,
    columns.title ? `${sqlIdent(columns.title)} AS title` : `${id} AS title`,
    columns.startedAt ? `${sqlIdent(columns.startedAt)} AS started_at` : "NULL AS started_at",
  ];
  const inlineChecks = [
    columns.transcriptJson
      ? `(CASE WHEN ${sqlIdent(columns.transcriptJson)} IS NOT NULL AND length(${sqlIdent(columns.transcriptJson)}) > 0 THEN 1 ELSE 0 END)`
      : null,
    columns.transcriptText
      ? `(CASE WHEN ${sqlIdent(columns.transcriptText)} IS NOT NULL AND length(${sqlIdent(columns.transcriptText)}) > 0 THEN 1 ELSE 0 END)`
      : null,
  ].filter(Boolean);
  selected.push(
    inlineChecks.length > 0
      ? `(${inlineChecks.join(" OR ")}) AS has_inline_transcript`
      : "0 AS has_inline_transcript",
  );
  return `SELECT ${selected.join(", ")} FROM conversation ORDER BY rowid DESC LIMIT ? OFFSET ?`;
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
  offset = 0,
): Promise<ConversationMeta[]> {
  const candidates = [
    mapConversationColumns(["id", "title", "started_at", "transcript_json", "transcript_text"]),
    mapConversationColumns(["id", "title", "started_at"]),
    mapConversationColumns(["id", "title"]),
    mapConversationColumns(["id"]),
  ];
  let res: Awaited<ReturnType<typeof sqlQuery>> | undefined;
  let lastMissingColumn: unknown;
  for (const columns of candidates) {
    try {
      res = await sqlQuery(
        conversationListSql(columns),
        { db: LISTEN_CONVERSATIONS_DB, space: target.space },
        [limit, offset],
        opts,
      );
      break;
    } catch (e) {
      if (!missingColumn(e)) throw e;
      lastMissingColumn = e;
    }
  }
  if (!res) throw lastMissingColumn;
  const col = (name: string) => res.columns.indexOf(name);
  const idCol = col("id");
  const titleCol = col("title");
  const startCol = col("started_at");
  const inlineCol = col("has_inline_transcript");
  if (idCol < 0) {
    throw new Error(
      `conversation table has no 'id' column (columns: ${res.columns.join(", ")})`,
    );
  }
  return res.rows.map((row) => ({
    id: String(row[idCol]),
    title: optionalString(row, titleCol) ?? String(row[idCol]),
    started_at: optionalString(row, startCol),
    has_inline_transcript: optionalBool(row, inlineCol) ?? false,
  }));
}

export async function fetchInlineTranscript(
  meta: ConversationMeta,
  target: ListenTarget,
  opts: TcRunOptions = {},
): Promise<ConversationMeta> {
  const attempts = [
    `SELECT transcript_json AS transcript_json, transcript_text AS transcript_text FROM conversation WHERE id = ? LIMIT 1`,
    `SELECT transcript_json AS transcript_json, NULL AS transcript_text FROM conversation WHERE id = ? LIMIT 1`,
    `SELECT NULL AS transcript_json, transcript_text AS transcript_text FROM conversation WHERE id = ? LIMIT 1`,
  ];
  let res: Awaited<ReturnType<typeof sqlQuery>> | undefined;
  for (const statement of attempts) {
    try {
      res = await sqlQuery(
        statement,
        { db: LISTEN_CONVERSATIONS_DB, space: target.space },
        [meta.id],
        opts,
      );
      break;
    } catch (e) {
      if (!missingColumn(e)) throw e;
    }
  }
  if (!res) return meta;
  const row = res.rows[0];
  if (!row) return meta;
  const transcriptJsonCol = res.columns.indexOf("transcript_json");
  const transcriptTextCol = res.columns.indexOf("transcript_text");
  return {
    ...meta,
    transcript_json: optionalString(row, transcriptJsonCol),
    transcript_text: optionalString(row, transcriptTextCol),
  };
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

export interface DumpCorpusOptions {
  /** Initial conversation-list offset. Used by the live agent to rotate runs. */
  offset?: number;
  /** Maximum number of conversation metadata rows to scan from the initial offset. */
  scanLimit?: number;
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
  options: DumpCorpusOptions = {},
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
  // Page metadata only; do not pull inline transcript payloads in the list
  // query. Some Listen rows carry multi-MB Fireflies transcript_json blobs, and
  // SELECT * across a broad scan exceeds TinyCloud's SQL response cap before the
  // pipeline gets a chance to apply backpressure.
  const CONVERSATION_PAGE_SIZE = 100;
  const startOffset = Math.max(0, Math.floor(options.offset ?? 0));
  const CONVERSATION_SCAN_LIMIT = Math.max(1, Math.floor(options.scanLimit ?? 10_000));
  const written: WrittenTranscript[] = [];
  for (
    let offset = startOffset;
    offset < startOffset + CONVERSATION_SCAN_LIMIT && written.length < count;
    offset += CONVERSATION_PAGE_SIZE
  ) {
    const conversations = await listConversations(CONVERSATION_PAGE_SIZE, target, opts, offset);
    if (conversations.length === 0) break;
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
      } else if (meta.has_inline_transcript) {
        try {
          turns = transcriptTurnsFromInline(await fetchInlineTranscript(meta, target, opts));
        } catch (e) {
          // A single huge inline transcript can still exceed the SQL response cap.
          // Skip that row and continue paging so one meeting cannot block the
          // whole feed run from finding smaller transcript-backed conversations.
          if (e instanceof TcCliError && e.code === "SQL_RESPONSE_TOO_LARGE") continue;
          throw e;
        }
      } else {
        turns = [];
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
