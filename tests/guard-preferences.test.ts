// guard-preferences.test.ts — the DETERMINISTIC human-line guard (PR #8
// finding A). Unit tests on the pure lib + end-to-end CLI tests proving that a
// human-line edit is REJECTED + the file RESTORED, a [learned]-only change is
// ACCEPTED, and the reserved-prefix edge case behaves per the preamble.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkHumanLinesUnchanged,
  humanLines,
  isLearnedBullet,
} from "../skills/distill-preferences/scripts/preferences-guard-lib.ts";

const CLI = resolve(
  import.meta.dir,
  "../skills/distill-preferences/scripts/guard-preferences.ts",
);

// ---------------------------------------------------------------------------
// pure lib
// ---------------------------------------------------------------------------

describe("isLearnedBullet (reserved-prefix contract)", () => {
  test("a top-level `- [learned]` bullet is agent-owned", () => {
    expect(isLearnedBullet("- [learned] More foundational theses (4 more, Jun 2026)")).toBe(true);
  });
  test("an INDENTED `- [learned]` sub-bullet is agent-owned", () => {
    expect(isLearnedBullet("  - [learned] sub-bullet under a human heading")).toBe(true);
  });
  test("an untagged human bullet is a human line", () => {
    expect(isLearnedBullet("- Less SPARQ-internal content")).toBe(false);
  });
  test("a `[learned]` mention NOT at bullet start is plain (human) text", () => {
    // Exactly the preamble's case: "[learned]" inside prose is not a tagged bullet.
    expect(isLearnedBullet("Agent-derived lines are bullets tagged `[learned]`.")).toBe(false);
    expect(isLearnedBullet("- promote a [learned] bullet by deleting the tag")).toBe(false);
  });
  test("headings, blanks, and comments are human lines", () => {
    expect(isLearnedBullet("## Topics")).toBe(false);
    expect(isLearnedBullet("")).toBe(false);
    expect(isLearnedBullet("<!-- example -->")).toBe(false);
  });
});

describe("humanLines", () => {
  test("filters out [learned] bullets, keeps everything else in order", () => {
    const md = [
      "# PREFERENCES",
      "",
      "## Topics",
      "- [learned] More X (2 more, Jun 2026)",
      "- A human authored line",
      "  - [learned] indented learned bullet",
    ].join("\n");
    expect(humanLines(md)).toEqual([
      "# PREFERENCES",
      "",
      "## Topics",
      "- A human authored line",
    ]);
  });
});

describe("checkHumanLinesUnchanged", () => {
  const base = [
    "# PREFERENCES",
    "## Topics",
    "- A sacrosanct human line",
    "- [learned] old learned bullet (1 more, Jun 2026)",
  ].join("\n");

  test("a [learned]-only change is OK (add/update/remove learned bullets)", () => {
    const after = [
      "# PREFERENCES",
      "## Topics",
      "- A sacrosanct human line",
      "- [learned] NEW stronger bullet (5 more, Jun 2026)",
      "- [learned] a second learned bullet (3 save, Jun 2026)",
    ].join("\n");
    const r = checkHumanLinesUnchanged(base, after);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.beforeCount).toBe(r.afterCount);
  });

  test("removing all [learned] bullets is still OK (human lines intact)", () => {
    const after = ["# PREFERENCES", "## Topics", "- A sacrosanct human line"].join("\n");
    expect(checkHumanLinesUnchanged(base, after).ok).toBe(true);
  });

  test("EDITING a human line is a violation", () => {
    const after = base.replace("A sacrosanct human line", "A TAMPERED human line");
    const r = checkHumanLinesUnchanged(base, after);
    expect(r.ok).toBe(false);
    expect(r.violations.join("\n")).toContain("CHANGED");
  });

  test("REMOVING a human line is a violation", () => {
    const after = [
      "# PREFERENCES",
      "## Topics",
      "- [learned] old learned bullet (1 more, Jun 2026)",
    ].join("\n");
    const r = checkHumanLinesUnchanged(base, after);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/COUNT changed|REMOVED/);
  });

  test("ADDING a new human line is a violation", () => {
    const after = [
      "# PREFERENCES",
      "## Topics",
      "- A sacrosanct human line",
      "- A line the agent SNUCK IN as human",
    ].join("\n");
    const r = checkHumanLinesUnchanged(base, after);
    expect(r.ok).toBe(false);
  });

  test("REORDERING human lines is a violation (order-sensitive)", () => {
    const before = ["- human one", "- human two"].join("\n");
    const after = ["- human two", "- human one"].join("\n");
    const r = checkHumanLinesUnchanged(before, after);
    expect(r.ok).toBe(false);
    expect(r.violations.join("\n")).toContain("CHANGED");
  });

  test("newline-style churn (CRLF) is NOT a violation", () => {
    const after = base.replace(/\n/g, "\r\n");
    expect(checkHumanLinesUnchanged(base, after).ok).toBe(true);
  });

  test("EDGE CASE: a human line that literally starts with `- [learned]` is — per the reserved-prefix convention — treated as agent-owned, so the guard does NOT protect it (documented contract)", () => {
    // The preamble RESERVES the `- [learned]` bullet-start prefix for agents.
    // A human who pastes such a line has authored an agent-shaped bullet; the
    // guard (correctly, per the convention) sees it as mutable. This test pins
    // that documented behavior so it never silently changes.
    const before = ["- A real human line", "- [learned] human pasted this (oops)"].join("\n");
    const afterAgentDeletesIt = ["- A real human line"].join("\n");
    // The agent deleting the pasted pseudo-learned line is NOT flagged — it is
    // a [learned] line by the reserved-prefix rule.
    expect(checkHumanLinesUnchanged(before, afterAgentDeletesIt).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// end-to-end CLI (snapshot → agent writes → check → restore-or-accept)
// ---------------------------------------------------------------------------

let dir: string;
let prefs: string;
let snap: string;

const SACROSANCT = [
  "# PREFERENCES",
  "",
  "## Topics",
  "- A human authored, authoritative line",
  "- [learned] old bullet (1 more, Jun 2026)",
  "",
].join("\n");

async function runCli(args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stderr };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "distillery-guard-"));
  prefs = join(dir, "PREFERENCES.md");
  snap = join(dir, "snapshot.md");
  await writeFile(prefs, SACROSANCT, "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("guard-preferences CLI", () => {
  test("legit [learned]-only change → snapshot, edit, check ACCEPTS + cleans up snapshot", async () => {
    const s = await runCli(["snapshot", "--preferences", prefs, "--snapshot", snap]);
    expect(s.code).toBe(0);
    expect(existsSync(snap)).toBe(true);

    // Agent edits ONLY [learned] lines.
    const edited = SACROSANCT.replace(
      "- [learned] old bullet (1 more, Jun 2026)",
      "- [learned] STRONGER bullet (5 more + 3 save, Jun 2026)\n- [learned] a brand new bullet (2 promote, Jun 2026)",
    );
    await writeFile(prefs, edited, "utf8");

    const c = await runCli(["check", "--preferences", prefs, "--snapshot", snap]);
    expect(c.code).toBe(0);
    expect(c.stderr).toContain("human");
    // file unchanged from the agent's edit (NOT restored)
    expect(await readFile(prefs, "utf8")).toBe(edited);
    // snapshot cleaned up on success
    expect(existsSync(snap)).toBe(false);
  });

  test("human line edited → check REJECTS (exit 1) + RESTORES the file", async () => {
    await runCli(["snapshot", "--preferences", prefs, "--snapshot", snap]);

    // Agent tampers with a human line.
    const tampered = SACROSANCT.replace(
      "A human authored, authoritative line",
      "A line the AGENT REWROTE",
    );
    await writeFile(prefs, tampered, "utf8");

    const c = await runCli(["check", "--preferences", prefs, "--snapshot", snap]);
    expect(c.code).toBe(1);
    expect(c.stderr).toContain("CARDINAL RULE VIOLATION");
    expect(c.stderr).toContain("RESTORED");
    // file restored to the pre-distill sacrosanct content
    expect(await readFile(prefs, "utf8")).toBe(SACROSANCT);
  });

  test("agent DELETES PREFERENCES.md → treated as full human-line removal → REJECT + RESTORE", async () => {
    await runCli(["snapshot", "--preferences", prefs, "--snapshot", snap]);
    await rm(prefs, { force: true });
    const c = await runCli(["check", "--preferences", prefs, "--snapshot", snap]);
    expect(c.code).toBe(1);
    expect(await readFile(prefs, "utf8")).toBe(SACROSANCT);
  });

  test("check without a prior snapshot REFUSES (exit 2) — never passes an unguarded write", async () => {
    const c = await runCli(["check", "--preferences", prefs, "--snapshot", snap]);
    expect(c.code).toBe(2);
    expect(c.stderr).toContain("no snapshot");
  });
});
