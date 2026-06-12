// preferences-guard-lib.ts — the DETERMINISTIC human-line guard for
// PREFERENCES.md (PR #8 review finding A). Pure, testable plumbing — no model
// calls, no I/O at import time. The CLI wrapper (guard-preferences.ts) does the
// file reads/writes/restore; this module decides what is sacrosanct and whether
// a write violated it.
//
// THE CARDINAL RULE, made unbreakable (not convention): agents may ONLY add,
// update, or remove agent-authored `- [learned]` bullets. Every OTHER line in
// PREFERENCES.md is HUMAN-authored and authoritative — it must survive an agent
// distill byte-for-byte, in the same order. This module snapshots the human
// lines BEFORE the agent writes and asserts they are unchanged AFTER. A single
// edited / removed / reordered human line is a REJECT (the caller restores the
// pre-write file from the snapshot and logs loudly).
//
// THE RESERVED-PREFIX CONVENTION (PREFERENCES.md preamble): the token
// `- [learned]` at the START of a bullet is RESERVED for agent-derived lines.
// Humans must never author it (to promote a learned bullet they delete the
// tag). So "is this line agent-owned?" reduces to a syntactic test — does the
// trimmed line start with `- [learned]` — with NO need to diff against the
// event log or guess intent. A `[learned]` mention anywhere other than the
// bullet start (e.g. inside the preamble prose) is plain text and is treated as
// a HUMAN line, exactly as the preamble says. This keeps the guard a pure
// string function: the reserved prefix is the whole contract.

/**
 * The reserved agent-bullet prefix. A line whose TRIMMED form starts with this
 * token is an agent-authored `[learned]` bullet (mutable by the distill); every
 * other line is human-authored and sacrosanct.
 *
 * We trim leading whitespace first so an indented `[learned]` bullet (a
 * sub-bullet under a human heading) is still recognized as agent-owned. We do
 * NOT trim trailing content — the match is purely on the bullet's opening
 * token.
 */
export const LEARNED_PREFIX = "- [learned]";

/**
 * Is this single line an agent-authored `[learned]` bullet (and therefore
 * MUTABLE by the distill)? True iff the line — after stripping leading
 * whitespace — begins with the reserved `- [learned]` token. Everything else
 * (headings, prose, blank lines, HTML comments, untagged human bullets, and any
 * `[learned]` mention that is NOT at a bullet start) is a HUMAN line.
 */
export function isLearnedBullet(line: string): boolean {
  return line.replace(/^\s+/, "").startsWith(LEARNED_PREFIX);
}

/**
 * The ORDERED list of human (non-[learned]) lines — the sacrosanct set the
 * guard protects. Order is preserved so a REORDER of human lines (not just an
 * edit/removal) is also caught: we compare these arrays element-by-element.
 *
 * Newlines are normalized (CRLF/CR → LF) before splitting so a tool that
 * rewrites line endings does not trip a false positive. The guard's concern is
 * human CONTENT + ORDER, not byte-identical line terminators.
 */
export function humanLines(content: string): string[] {
  return normalizeNewlines(content)
    .split("\n")
    .filter((line) => !isLearnedBullet(line));
}

/** Normalize CRLF / lone CR to LF so newline-style churn is not a violation. */
export function normalizeNewlines(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

/** The outcome of comparing a post-write file against the pre-write snapshot. */
export interface GuardResult {
  /** True iff every human line survived unchanged AND in the same order. */
  ok: boolean;
  /**
   * Human-readable violations (empty when ok). Each entry names what changed —
   * a removed line, an added line, or an edited/reordered one — so the loud log
   * is actionable. NEVER contains generation content, only PREFERENCES lines.
   */
  violations: string[];
  /** Count of human lines before / after (a cheap at-a-glance signal). */
  beforeCount: number;
  afterCount: number;
}

/**
 * The DETERMINISTIC assertion at the heart of the guard. Compare the human
 * lines of the pre-write snapshot against the human lines of the post-write
 * file. ANY difference — a human line edited, removed, added, or reordered — is
 * a violation. Adding/updating/removing `[learned]` bullets is invisible here
 * (those lines are filtered out), so a legit distill passes cleanly.
 *
 * Pure: it does not read or write files. The CLI feeds it the two contents and
 * acts on `ok` (restore + loud log when false).
 */
export function checkHumanLinesUnchanged(
  before: string,
  after: string,
): GuardResult {
  const beforeLines = humanLines(before);
  const afterLines = humanLines(after);
  const violations: string[] = [];

  if (beforeLines.length !== afterLines.length) {
    violations.push(
      `human (non-[learned]) line COUNT changed: ${beforeLines.length} → ${afterLines.length} ` +
        `(agents may only add/update/remove "- [learned]" bullets)`,
    );
  }

  // Element-wise compare in order — catches edits AND reorders. We report up to
  // the first few divergences with 1-based line indices (within the human-line
  // sequence) so the log points at the offending content without dumping the
  // whole file.
  const max = Math.max(beforeLines.length, afterLines.length);
  let reported = 0;
  for (let i = 0; i < max && reported < 5; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b !== a) {
      if (b === undefined) {
        violations.push(`human line #${i + 1} ADDED: ${fmt(a!)}`);
      } else if (a === undefined) {
        violations.push(`human line #${i + 1} REMOVED: ${fmt(b)}`);
      } else {
        violations.push(`human line #${i + 1} CHANGED: ${fmt(b)} → ${fmt(a)}`);
      }
      reported++;
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    beforeCount: beforeLines.length,
    afterCount: afterLines.length,
  };
}

/** Quote + clip a line for a log message (keeps the loud error one-line-ish). */
function fmt(line: string): string {
  const clipped = line.length > 120 ? line.slice(0, 117) + "…" : line;
  return JSON.stringify(clipped);
}
