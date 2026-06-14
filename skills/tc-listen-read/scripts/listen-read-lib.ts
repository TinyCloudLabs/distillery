// listen-read-lib.ts — read curated Listen conversations + transcripts from
// TinyCloud and write them to a local corpus dir the distillery generation
// skills consume (they take transcript paths at invocation).
//
// Listen is a manifest app (app_id xyz.tinycloud.listen). Its canonical data
// lives in the OWNER's `applications` space:
//   - conversations (SQL): --db xyz.tinycloud.listen/conversations  → tables
//     `conversation`, `participant`.
//   - transcripts (KV): xyz.tinycloud.listen/transcript/<conversationId> →
//     JSON array of { index, speaker_id, speaker_name, text, start_time, … }.
//
// Access model (§3.4): the agent runs the real read; on AUTH_UNAUTHORIZED the
// caller drives the delegate-asks-owner handshake (request → owner grant →
// import → retry). For V1 the agent MAY be the owner of the Listen space
// (self-grant), but this lib never assumes that — it only reads and lets the
// TcCliError surface so the skill's remediation path runs. No fallback to fake
// data, no swallowing of a missing-cap error.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sqlQuery, tcJson, type TcRunOptions } from "../../_shared/lib/tc.ts";
import { slugify } from "../../_shared/lib/artifact.ts";

const LISTEN_CONVERSATIONS_DB = "xyz.tinycloud.listen/conversations";
const TRANSCRIPT_PREFIX = "xyz.tinycloud.listen/transcript";

export interface ListenTarget {
  /** --space name or URI of the Listen OWNER's applications space. */
  space?: string;
}

export interface ConversationMeta {
  id: string;
  title: string;
  /** ISO-ish start time if the row carries one (display only). */
  started_at?: string;
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
  if (idCol < 0) {
    throw new Error(
      `conversation table has no 'id' column (columns: ${res.columns.join(", ")})`,
    );
  }
  return res.rows.map((row) => ({
    id: String(row[idCol]),
    title:
      titleCol !== undefined && row[titleCol] != null
        ? String(row[titleCol])
        : String(row[idCol]),
    started_at:
      startCol !== undefined && row[startCol] != null
        ? String(row[startCol])
        : undefined,
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
  const conversations = await listConversations(count, target, opts);
  const written: WrittenTranscript[] = [];
  for (const meta of conversations) {
    const turns = await fetchTranscript(meta.id, target, opts);
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
