// Feedback event log — revealed-preference backpressure for the feed.
//
// Actions on feed cards are appended to an append-only JSONL file
// (feedback/events.jsonl at the repo root by convention; gitignored —
// personal data, like artifacts/). The distill-preferences skill reads
// the log, aggregates it, and proposes [learned] updates to PREFERENCES.md.
//
// Exactly six actions, each teaching one unambiguous lesson:
//   more          positive signal + generalize (more like this)
//   less          negative signal + generalize (removes from feed)
//   save          utility (worth keeping, independent of more/less)
//   already_knew  novelty calibration (true but not new to the reader)
//   wrong         accuracy challenge (claim is disputed)
//   promote       commission a deeper artifact from this card
//
// Plain TS, no deps — same constraint as the rest of _shared/lib.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const FEEDBACK_ACTIONS = [
  "more",
  "less",
  "save",
  "already_knew",
  "wrong",
  "promote",
] as const;

export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];

export function isFeedbackAction(value: unknown): value is FeedbackAction {
  return (
    typeof value === "string" &&
    (FEEDBACK_ACTIONS as readonly string[]).includes(value)
  );
}

export interface FeedbackEvent {
  artifact_id: string;
  artifact_type: string;
  action: FeedbackAction;
  /** Optional free-text note attached to the action. */
  note?: string;
  /** ISO 8601 timestamp of the action. */
  ts: string;
}

/** Minimal artifact shape needed to join events with tags/headlines. */
export interface FeedbackArtifactRef {
  id: string;
  type?: string;
  tags?: string[];
  headline?: string;
}

export type ActionCounts = Record<FeedbackAction, number>;

export function zeroCounts(): ActionCounts {
  return { more: 0, less: 0, save: 0, already_knew: 0, wrong: 0, promote: 0 };
}

export interface NoteEntry {
  action: FeedbackAction;
  note: string;
  ts: string;
}

export interface ArtifactFeedbackSummary {
  artifact_id: string;
  artifact_type: string;
  /** Joined from artifacts when provided. */
  headline?: string;
  tags?: string[];
  actions: ActionCounts;
  total: number;
  notes: NoteEntry[];
  last_ts: string;
}

export interface GroupFeedbackSummary {
  /** The tag or artifact type this row aggregates. */
  key: string;
  actions: ActionCounts;
  total: number;
  /** Distinct artifacts contributing events to this group. */
  artifacts: number;
}

export interface FeedbackSummary {
  total_events: number;
  by_action: ActionCounts;
  /** Sorted by event count desc, then artifact_id. */
  by_artifact: ArtifactFeedbackSummary[];
  /** Per artifact type. Sorted by event count desc, then key. */
  by_type: GroupFeedbackSummary[];
  /** Per tag — only populated when artifacts are provided for the join. */
  by_tag: GroupFeedbackSummary[];
}

/**
 * Append one event to the JSONL log. Creates parent directories. The write
 * is a single appendFile call of one `\n`-terminated line — atomic enough
 * for a single-user local log (no interleaved partial lines from one
 * process; readEvents tolerates a trailing partial line regardless).
 *
 * Validation mirrors `parseEventLine` so the invariant holds: anything
 * appended here is readable by `readEvents` — a JS caller (or a TS caller
 * spreading partial data) can't persist an event that silently vanishes
 * on read.
 */
export async function appendEvent(
  filePath: string,
  event: FeedbackEvent,
): Promise<void> {
  if (!isFeedbackAction(event.action)) {
    throw new Error(
      `invalid action "${String(event.action)}" — must be one of ${FEEDBACK_ACTIONS.join(", ")}`,
    );
  }
  if (typeof event.artifact_id !== "string" || !event.artifact_id.trim()) {
    throw new Error("invalid artifact_id — must be a non-empty string");
  }
  if (typeof event.artifact_type !== "string") {
    throw new Error("invalid artifact_type — must be a string");
  }
  if (typeof event.ts !== "string" || !event.ts.trim()) {
    throw new Error("invalid ts — must be a non-empty ISO 8601 string");
  }
  if (event.note !== undefined && typeof event.note !== "string") {
    throw new Error("invalid note — must be a string when present");
  }
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
}

function parseEventLine(line: string): FeedbackEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.artifact_id !== "string" || !e.artifact_id.trim()) return null;
  if (typeof e.artifact_type !== "string") return null;
  if (!isFeedbackAction(e.action)) return null;
  if (typeof e.ts !== "string" || !e.ts.trim()) return null;
  const event: FeedbackEvent = {
    artifact_id: e.artifact_id,
    artifact_type: e.artifact_type,
    action: e.action,
    ts: e.ts,
  };
  // Trim to match the API write path, which stores trimmed notes.
  if (typeof e.note === "string" && e.note.trim()) event.note = e.note.trim();
  return event;
}

/**
 * Read all events from the JSONL log. Missing file → []. Malformed lines
 * (including a trailing partial line from an interrupted write) are
 * skipped, never fatal.
 */
export async function readEvents(filePath: string): Promise<FeedbackEvent[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const events: FeedbackEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const event = parseEventLine(line);
    if (event) events.push(event);
  }
  return events;
}

/**
 * Aggregate events per artifact, per artifact type, and (when artifacts
 * are provided for the join) per tag.
 */
export function summarizeEvents(
  events: FeedbackEvent[],
  artifacts?: FeedbackArtifactRef[],
): FeedbackSummary {
  const byId = new Map<string, FeedbackArtifactRef>();
  for (const a of artifacts ?? []) byId.set(a.id, a);

  const byAction = zeroCounts();
  const perArtifact = new Map<string, ArtifactFeedbackSummary>();
  const perType = new Map<string, { counts: ActionCounts; ids: Set<string> }>();
  const perTag = new Map<string, { counts: ActionCounts; ids: Set<string> }>();

  const bump = (
    map: Map<string, { counts: ActionCounts; ids: Set<string> }>,
    key: string,
    event: FeedbackEvent,
  ) => {
    let row = map.get(key);
    if (!row) {
      row = { counts: zeroCounts(), ids: new Set() };
      map.set(key, row);
    }
    row.counts[event.action] += 1;
    row.ids.add(event.artifact_id);
  };

  for (const event of events) {
    byAction[event.action] += 1;

    const ref = byId.get(event.artifact_id);
    // Joined artifact metadata wins over what the event carried.
    const type = ref?.type?.trim() || event.artifact_type || "unknown";

    let row = perArtifact.get(event.artifact_id);
    if (!row) {
      row = {
        artifact_id: event.artifact_id,
        artifact_type: type,
        actions: zeroCounts(),
        total: 0,
        notes: [],
        last_ts: event.ts,
      };
      if (ref?.headline) row.headline = ref.headline;
      if (ref?.tags && ref.tags.length > 0) row.tags = [...ref.tags];
      perArtifact.set(event.artifact_id, row);
    }
    row.actions[event.action] += 1;
    row.total += 1;
    // Compare instants, not strings — events written by skills/by hand can
    // carry mixed ISO forms ("…Z" vs "….000Z" vs offsets) that mis-order
    // lexically. NaN comparisons are false, so unparseable ts keeps the
    // first-seen value (same tolerance as the read side).
    if (Date.parse(event.ts) > Date.parse(row.last_ts)) row.last_ts = event.ts;
    if (event.note) {
      row.notes.push({ action: event.action, note: event.note, ts: event.ts });
    }

    bump(perType, type, event);
    for (const tag of ref?.tags ?? []) bump(perTag, tag, event);
  }

  const groupRows = (
    map: Map<string, { counts: ActionCounts; ids: Set<string> }>,
  ): GroupFeedbackSummary[] =>
    [...map.entries()]
      .map(([key, row]) => ({
        key,
        actions: row.counts,
        total: Object.values(row.counts).reduce((a, b) => a + b, 0),
        artifacts: row.ids.size,
      }))
      .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));

  return {
    total_events: events.length,
    by_action: byAction,
    by_artifact: [...perArtifact.values()].sort(
      (a, b) => b.total - a.total || a.artifact_id.localeCompare(b.artifact_id),
    ),
    by_type: groupRows(perType),
    by_tag: groupRows(perTag),
  };
}
