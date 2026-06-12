// feedrun-wrapper-guard.test.ts — END-TO-END coverage of the PRODUCTION guard
// (PR #8 BLOCKER fix).
//
// The deterministic human-line guard + distill verification used to be wired
// ONLY into feed-run.ts's real-generation `else` branch — a code path
// PRODUCTION NEVER RUNS. Production spawns harness/ops/launchd/feedrun.sh, whose
// `claude -p` agent self-distills + self-generates, skipping that branch. So the
// guard was unreachable in production: PREFERENCES.md human lines were protected
// only by prose.
//
// The fix BRACKETS the agent call in feedrun.sh with snapshot → check →
// verify-distill. These tests drive the REAL wrapper through that production
// sequence, with `claude` stubbed as a MISBEHAVING agent that edits a human
// line, and assert:
//   1. the human line is RESTORED from the snapshot;
//   2. the run-log records guard=violation (the wrapper caught it, not prose);
//   3. a well-behaved agent (only [learned] edits) passes guard=ok;
//   4. an agent that does nothing while events are pending → distill_skipped=true.
//
// No real model call, no Gemini spend: `claude` is a local stub. `bun` is real
// (the guard/verify scripts are bun TS with only node: + relative imports), so
// the temp repo SYMLINKS the real skills/ tree (for _shared) AND the real
// harness/distill-preferences tree (where the guard/verify scripts now live).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const REPO = resolve(import.meta.dir, "..");
const WRAPPER = join(REPO, "harness", "ops", "launchd", "feedrun.sh");

let repo: string;
let binDir: string;

// A human line the agent must NEVER touch, and an agent-owned [learned] bullet
// it MAY edit.
const HUMAN_LINE = "- prefer single-voice thesis cards over roundups";
const PREFS_BEFORE = ["## Topics", HUMAN_LINE, "- [learned] old (1 more, Jun 2026)"].join("\n") + "\n";

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "feedrun-wrapper-guard-"));
  binDir = join(repo, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(repo, "harness", "ops", "launchd"), { recursive: true });
  await mkdir(join(repo, "index"), { recursive: true });
  await mkdir(join(repo, "feedback"), { recursive: true });
  await mkdir(join(repo, "artifacts"), { recursive: true });

  // Symlink the REAL skills/ tree (so `_shared/lib` resolves) AND the real
  // harness/distill-preferences tree, where the guard + verify scripts the
  // wrapper invokes (`bun harness/distill-preferences/...`) now live. They import
  // only node: + relative .ts, so no node_modules is needed in the temp repo.
  await symlink(join(REPO, "skills"), join(repo, "skills"));
  await symlink(
    join(REPO, "harness", "distill-preferences"),
    join(repo, "harness", "distill-preferences"),
  );

  // The real wrapper, copied into the temp repo layout (it resolves REPO from
  // $SCRIPT_DIR/../../..).
  await writeFile(join(repo, "harness", "ops", "launchd", "feedrun.sh"), await Bun.file(WRAPPER).text());
  await chmod(join(repo, "harness", "ops", "launchd", "feedrun.sh"), 0o755);

  // Real `bun` (find it on the host PATH) symlinked into the stub bin so the
  // wrapper's prereq `command -v bun` passes AND the guard/verify scripts run.
  const realBun = Bun.which("bun");
  if (!realBun) throw new Error("bun not on PATH for the wrapper-guard test");
  await symlink(realBun, join(binDir, "bun"));

  // feedrun.env: stub bin first on PATH, a corpus dir so the prereq passes.
  await writeFile(
    join(repo, "harness", "ops", "launchd", "feedrun.env"),
    `export PATH="${binDir}:$PATH"\nexport TRANSCRIPT_DIRS="${repo}/corpus"\n`,
  );

  // Seed PREFERENCES.md with a human line + a learned bullet.
  await writeFile(join(repo, "PREFERENCES.md"), PREFS_BEFORE, "utf8");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/**
 * Install a stub `claude` that, when invoked (`claude -p ...`), acts as the
 * headless agent: it runs the supplied bash snippet against PREFERENCES.md, then
 * exits 0. This is exactly where the real agent self-distills — the wrapper's
 * guard brackets THIS call.
 */
async function installClaudeStub(agentBody: string): Promise<void> {
  const stub = join(binDir, "claude");
  await writeFile(
    stub,
    `#!/bin/bash\n# stub headless agent — edits PREFERENCES.md, no model call\nset -e\n${agentBody}\nexit 0\n`,
    "utf8",
  );
  await chmod(stub, 0o755);
}

function runWrapper(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [join(repo, "harness", "ops", "launchd", "feedrun.sh")], {
      env: {
        HOME: process.env.HOME,
        PATH: `${binDir}:/usr/bin:/bin`,
        FEEDRUN_DRY_RUN: "0",
        FEEDRUN_MODEL: "opus",
      },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

async function readRunLog(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(repo, "index", "run-log.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("feedrun.sh production wrapper guard (PR #8 BLOCKER)", () => {
  test("a misbehaving agent that edits a HUMAN line → line RESTORED + guard=violation in the run-log", async () => {
    // The agent rewrites the human line (the cardinal-rule violation) AND edits a
    // learned bullet. Production's only protection used to be prose; now the
    // wrapper catches + reverts it deterministically.
    await installClaudeStub(
      // Rewrite the file: corrupt the human line, change the learned bullet.
      `printf '%s\\n' '## Topics' '- CORRUPTED human preference by the agent' '- [learned] new (5 more, Jun 2026)' > "${repo}/PREFERENCES.md"`,
    );

    const code = await runWrapper();
    expect(code).toBe(0); // a guard violation does not fail the run — it restores + logs

    // 1. The human line is RESTORED byte-for-byte from the pre-run snapshot.
    const after = await readFile(join(repo, "PREFERENCES.md"), "utf8");
    expect(after).toContain(HUMAN_LINE);
    expect(after).not.toContain("CORRUPTED human preference");
    // The whole file is the pre-run snapshot (the learned edit is reverted too,
    // because a human-line violation restores the ENTIRE file).
    expect(after).toBe(PREFS_BEFORE);

    // 2. The wrapper recorded the violation in the run-log — the production proof.
    const log = await readRunLog();
    const guardLine = log.find((e) => e.wrapper_guard === "ran");
    expect(guardLine).toBeDefined();
    expect(guardLine!.guard).toBe("violation");
  });

  test("a well-behaved agent (only [learned] edits) → human line intact + guard=ok", async () => {
    await installClaudeStub(
      `printf '%s\\n' '## Topics' '${HUMAN_LINE}' '- [learned] refined (3 more, Jun 2026)' > "${repo}/PREFERENCES.md"`,
    );

    const code = await runWrapper();
    expect(code).toBe(0);

    const after = await readFile(join(repo, "PREFERENCES.md"), "utf8");
    expect(after).toContain(HUMAN_LINE);
    expect(after).toContain("[learned] refined (3 more, Jun 2026)"); // the legit edit survived
    expect(after).not.toContain("[learned] old"); // the old bullet is gone

    const log = await readRunLog();
    const guardLine = log.find((e) => e.wrapper_guard === "ran");
    expect(guardLine!.guard).toBe("ok");
  });

  test("an agent that distills NOTHING while feedback events are pending → distill_skipped=true", async () => {
    // 3 `more` events on one artifact (clears the ≥2-signal bar). The stub agent
    // leaves PREFERENCES.md unchanged and writes no "no change" claim → the
    // wrapper's verify-distill flags the skipped loop.
    const events = [
      { artifact_id: "p", artifact_type: "insight-card", action: "more", ts: "2026-06-11T23:00:00Z" },
      { artifact_id: "p", artifact_type: "insight-card", action: "more", ts: "2026-06-12T01:00:00Z" },
      { artifact_id: "p", artifact_type: "insight-card", action: "more", ts: "2026-06-12T02:00:00Z" },
    ];
    await writeFile(
      join(repo, "feedback", "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    // Seed a cursor whose fingerprint MATCHES the current PREFERENCES.md (the
    // state after a prior distill that consumed nothing newer than the events) so
    // an unchanged file reads as learnedChanged=false — the real no-op case.
    const { learnedFingerprint } = await import(
      "../harness/distill-preferences/scripts/distill-verify-lib.ts"
    );
    await writeFile(
      join(repo, "index", "distill-cursor.json"),
      JSON.stringify({ version: 1, learned_fingerprint: learnedFingerprint(PREFS_BEFORE) }),
      "utf8",
    );
    // Agent touches nothing (no-op distill, no learned change, no claim).
    await installClaudeStub(`true`);

    const code = await runWrapper();
    expect(code).toBe(0);

    const log = await readRunLog();
    const guardLine = log.find((e) => e.wrapper_guard === "ran");
    expect(guardLine!.guard).toBe("ok"); // no human line touched
    expect(guardLine!.distill_skipped).toBe(true); // but the loop did NOT close
  });
});
