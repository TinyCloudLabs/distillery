// feedrun-progress-markers.test.ts — assert the wrapper instructs the headless
// agent to append progress markers (the soft ACTIVITY signal for the staged
// Generate UI). This is a STATIC contract check over the real wrapper source:
// the instruction must be present, must point at progress.jsonl in the run dir,
// and must be explicitly OPTIONAL/non-fatal so a missing file never fails a run.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const WRAPPER = join(REPO, "harness", "ops", "launchd", "feedrun.sh");

describe("feedrun.sh — progress-marker instruction", () => {
  test("the wrapper tells the agent to append to progress.jsonl in the run dir", async () => {
    const src = await readFile(WRAPPER, "utf8");
    expect(src).toContain("progress.jsonl");
    // The marker note is woven into the SYSTEM_PROMPT the agent receives.
    expect(src).toContain("PROGRESS_NOTE");
    expect(src).toContain("${PROGRESS_NOTE}");
    // It points at THIS run's dir (so the status endpoint tails the right file).
    expect(src).toContain("index/runs/");
  });

  test("the instruction documents the {ts,detail} JSON line shape", async () => {
    const src = await readFile(WRAPPER, "utf8");
    expect(src).toContain('\\"ts\\"');
    expect(src).toContain('\\"detail\\"');
  });

  test("markers are explicitly OPTIONAL / non-fatal (graceful degrade)", async () => {
    const src = await readFile(WRAPPER, "utf8");
    const lower = src.toLowerCase();
    expect(lower).toContain("optional");
    // Must say the run should NOT fail / should skip silently on a write failure.
    expect(lower).toMatch(/never (block|fail)|skip it silently|never fail the run/);
  });
});
