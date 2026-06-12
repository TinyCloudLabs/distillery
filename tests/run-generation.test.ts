// run-generation.test.ts — the headless generation runner (spec §7/§8).
//
// THE PIECE THAT WAS NEVER WIRED: given a run-brief, invoke a generation AGENT
// HEADLESSLY (`claude -p`) to produce artifacts. These tests prove the
// orchestration WITHOUT ever calling claude or generating:
//
//   1. The `claude -p` invocation shape — argv + system-prompt + model + the
//      $MEET_GEN_MODEL / --model precedence — asserted against a MOCKED spawn.
//   2. The before/after artifacts/ diff logic (what was created this run).
//   3. The agent-stdout "killed" summary parsing.
//   4. The runner end-to-end with an INJECTED spawn that simulates the agent
//      writing an artifact — never the real claude.
//   5. The feed-run wiring: --dry-run / --no-generate stop at the brief; a real
//      run invokes generation. The CLI integration uses a FAKE `claude` on PATH
//      (a tiny script) so no real agent / model is ever called.
//
// NO real claude call, NO real generation, anywhere in this file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildClaudeInvocation,
  buildSummary,
  buildSystemPrompt,
  buildUserMessage,
  dedupBySignal,
  DEFAULT_GEN_MODEL,
  diffCreated,
  enforceCap,
  parseKilled,
  readSignalFingerprint,
  resolveModel,
  sameSignal,
  scanArtifacts,
  summarizeGeneration,
  type ArtifactRef,
  type GenInvocationInput,
} from "../skills/feed-run/scripts/run-generation-lib.ts";
import { runGeneration, type SpawnFn } from "../skills/feed-run/scripts/run-generation.ts";

const REPO = join(import.meta.dir, "..");

function invInput(over: Partial<GenInvocationInput> = {}): GenInvocationInput {
  return {
    briefPath: "/abs/runs/2026-06-11T14-00-00Z/run-brief.md",
    repoRoot: "/abs/repo",
    artifactsDir: "/abs/repo/artifacts",
    cap: 3,
    model: "opus",
    runId: "2026-06-11T14:00:00Z",
    ...over,
  };
}

// ===========================================================================
// 1. the claude -p invocation shape (mocked — never spawns claude)
// ===========================================================================

describe("model resolution", () => {
  test("flag wins over env wins over the opus default", () => {
    expect(resolveModel("sonnet", { MEET_GEN_MODEL: "haiku" })).toBe("sonnet");
    expect(resolveModel(undefined, { MEET_GEN_MODEL: "haiku" })).toBe("haiku");
    expect(resolveModel(undefined, {})).toBe("opus");
    expect(resolveModel(undefined, {})).toBe(DEFAULT_GEN_MODEL);
    // Blank flag/env fall through.
    expect(resolveModel("  ", { MEET_GEN_MODEL: "haiku" })).toBe("haiku");
    expect(resolveModel(undefined, { MEET_GEN_MODEL: "" })).toBe("opus");
  });
});

describe("buildClaudeInvocation (the reference_claude_cli_headless recipe)", () => {
  test("cmd is claude; argv is -p <msg> --system-prompt <override> --model <m>", () => {
    const { cmd, args } = buildClaudeInvocation(invInput({ model: "opus" }));
    expect(cmd).toBe("claude");
    // -p with a user message first.
    expect(args[0]).toBe("-p");
    expect(typeof args[1]).toBe("string");
    expect(args[1]!.length).toBeGreaterThan(0);
    // --system-prompt fully OVERRIDES (not --append-system-prompt) for a clean run.
    expect(args).toContain("--system-prompt");
    expect(args).not.toContain("--append-system-prompt");
    // --model carries the resolved model.
    const mi = args.indexOf("--model");
    expect(mi).toBeGreaterThan(-1);
    expect(args[mi + 1]).toBe("opus");
    // The system prompt is the arg right after --system-prompt.
    const si = args.indexOf("--system-prompt");
    expect(args[si + 1]).toBe(buildSystemPrompt(invInput({ model: "opus" })));
  });

  test("the system prompt instructs: read brief, run skills, critic, cap, save, ledger", () => {
    const sp = buildSystemPrompt(invInput({ cap: 3 }));
    expect(sp).toContain("/abs/runs/2026-06-11T14-00-00Z/run-brief.md"); // brief path
    expect(sp).toContain("extract-insights");
    expect(sp).toContain("write-article");
    expect(sp).toContain("make-podcast");
    expect(sp).toContain("adversarial"); // the novelty critic
    expect(sp).toContain("novelty");
    expect(sp).toMatch(/cap.*3|3.*cap|MAX_ARTIFACTS_PER_RUN.*3/);
    expect(sp).toContain("save.ts");
    expect(sp).toContain("surfaced ledger");
    // IN-RUN DEDUP instruction: read the ledger + already-created artifacts this
    // run, one signal → one artifact across formats (the core upgrade's prompt half).
    expect(sp).toMatch(/ONE SIGNAL.*ONE ARTIFACT|one artifact ships per underlying signal/i);
    expect(sp).toMatch(/already created.*this run|this run/i);
    // Must NOT advance the cursor (orchestrator owns it).
    expect(sp).toMatch(/not.*cursor|cursor.*already/i);
  });

  // FIX A — the headless agent's marching orders mandate distill-preferences as
  // the FIRST task (close the loop) BEFORE generating, touching only [learned]
  // lines and re-reading PREFERENCES.md afterward.
  test("the system prompt mandates distill-preferences as the first task", () => {
    const sp = buildSystemPrompt(invInput({ cap: 3 }));
    expect(sp).toContain("distill-preferences");
    expect(sp).toMatch(/CLOSE THE PREFERENCE LOOP|close the preference loop/i);
    expect(sp).toContain("[learned]");
    expect(sp).toContain("PREFERENCES.md");
    expect(sp).toMatch(/NOT skippable|not skippable/i);
    expect(sp).toMatch(/re-read|RE-READ/);
    expect(sp).toMatch(/>=2 consistent signals|2 consistent signals/i);
  });

  test("cap flows into both the system prompt and the user message", () => {
    const sp = buildSystemPrompt(invInput({ cap: 25 }));
    expect(sp).toContain("25");
    const um = buildUserMessage(invInput({ cap: 25 }));
    expect(um).toContain("25");
    expect(um).toContain("/abs/runs/2026-06-11T14-00-00Z/run-brief.md");
  });
});

// ===========================================================================
// 2. before/after artifact diff
// ===========================================================================

function ref(key: string): ArtifactRef {
  const [type, slug] = key.split("/");
  return { type: type as ArtifactRef["type"], slug: slug!, key, dir: `/abs/${key}` };
}

describe("diffCreated", () => {
  test("returns only after-keys absent from before", () => {
    const before = [ref("insight-card/a"), ref("article/b")];
    const after = [ref("insight-card/a"), ref("article/b"), ref("podcast/c")];
    const created = diffCreated(before, after);
    expect(created.map((r) => r.key)).toEqual(["podcast/c"]);
  });

  test("no new artifacts → empty (zero-artifact run is valid)", () => {
    const same = [ref("insight-card/a")];
    expect(diffCreated(same, same)).toEqual([]);
  });

  test("a deletion does not register as a creation", () => {
    const before = [ref("insight-card/a"), ref("article/b")];
    const after = [ref("insight-card/a")];
    expect(diffCreated(before, after)).toEqual([]);
  });
});

describe("scanArtifacts (filesystem)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scan-art-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("missing artifacts dir → empty (never throws)", async () => {
    expect(await scanArtifacts(join(dir, "nope"))).toEqual([]);
  });

  test("only folders WITH an artifact.json count; types are scoped", async () => {
    await mkdir(join(dir, "insight-card", "good"), { recursive: true });
    await writeFile(join(dir, "insight-card", "good", "artifact.json"), "{}");
    // A stray folder with no artifact.json is ignored.
    await mkdir(join(dir, "insight-card", "stray"), { recursive: true });
    await mkdir(join(dir, "podcast", "pod"), { recursive: true });
    await writeFile(join(dir, "podcast", "pod", "artifact.json"), "{}");
    const refs = await scanArtifacts(dir);
    const keys = refs.map((r) => r.key).sort();
    expect(keys).toEqual(["insight-card/good", "podcast/pod"]);
  });
});

// ===========================================================================
// 3. killed-summary parsing
// ===========================================================================

describe("parseKilled", () => {
  test("parses label (reason) fragments from a killed line", () => {
    const k = parseKilled("Killed: foo-card (re-angles prior), bar-pod (no novelty)");
    expect(k).toEqual([
      { label: "foo-card", reason: "re-angles prior" },
      { label: "bar-pod", reason: "no novelty" },
    ]);
  });

  test("bare labels (no parens) still parse", () => {
    expect(parseKilled("killed 2: alpha, beta")).toEqual([
      { label: "alpha" },
      { label: "beta" },
    ]);
  });

  test("explicit none → empty", () => {
    expect(parseKilled("Killed: none")).toEqual([]);
    expect(parseKilled("killed: 0")).toEqual([]);
  });

  test("no killed line → empty", () => {
    expect(parseKilled("shipped 1 insight card. all good.")).toEqual([]);
  });
});

describe("buildSummary + summarizeGeneration", () => {
  test("assembles created/killed/duration/exit and a one-line summary", () => {
    const s = buildSummary({
      created: [{ type: "insight-card", slug: "x", novelty: 0.8 }],
      stdout: "Killed: y (dup)",
      duration: 1234,
      exitCode: 0,
    });
    expect(s.created).toHaveLength(1);
    expect(s.killed).toEqual([{ label: "y", reason: "dup" }]);
    expect(s.duration).toBe(1234);
    expect(s.exit_code).toBe(0);
    const line = summarizeGeneration(s);
    expect(line).toContain("created=1");
    expect(line).toContain("insight-card/x");
    expect(line).toContain("killed=1");
    expect(line).toContain("exit=0");
  });
});

// ===========================================================================
// 4. runGeneration end-to-end with an INJECTED spawn (no real claude)
// ===========================================================================

describe("runGeneration (injected spawn — never calls claude)", () => {
  let dir: string;
  let artifactsDir: string;
  let briefPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "run-gen-"));
    artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const runDir = join(dir, "runs", "2026-06-11T14-00-00Z");
    await mkdir(runDir, { recursive: true });
    briefPath = join(runDir, "run-brief.md");
    await writeFile(briefPath, "# Feed-run brief\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("invokes claude -p with the right argv, captures the log, diffs the new artifact", async () => {
    let seenCmd = "";
    let seenArgs: string[] = [];
    // The injected agent: asserts it was handed `claude -p ...`, then simulates
    // writing one artifact (what a real agent would do).
    const spawn: SpawnFn = (cmd, args, optsArg) => {
      seenCmd = cmd;
      seenArgs = args;
      const created = join(artifactsDir, "insight-card", "new-card");
      // (sync write so the post-spawn scan sees it — mirrors a real agent.)
      const fs = require("node:fs");
      fs.mkdirSync(created, { recursive: true });
      fs.writeFileSync(
        join(created, "artifact.json"),
        JSON.stringify({ novelty: 0.9 }),
      );
      void optsArg;
      return { status: 0, stdout: "Shipped 1. Killed: thin-pod (no novelty)", stderr: "" };
    };

    let t = 1000;
    const summary = await runGeneration({
      briefPath,
      artifactsDir,
      cap: 3,
      repoRoot: dir,
      runId: "2026-06-11T14:00:00Z",
      spawn,
      env: {},
      now: () => (t += 500), // start..end → 500ms duration
    });

    // The injected spawn received the headless recipe.
    expect(seenCmd).toBe("claude");
    expect(seenArgs[0]).toBe("-p");
    expect(seenArgs).toContain("--system-prompt");
    expect(seenArgs[seenArgs.indexOf("--model") + 1]).toBe("opus"); // default

    // The diff caught the created artifact + read its novelty.
    expect(summary.created).toEqual([
      { type: "insight-card", slug: "new-card", novelty: 0.9 },
    ]);
    // Killed parsed from stdout.
    expect(summary.killed).toEqual([{ label: "thin-pod", reason: "no novelty" }]);
    expect(summary.exit_code).toBe(0);
    expect(summary.duration).toBe(500);

    // The agent's stdout was captured to the generation log.
    const log = await readFile(join(dir, "runs", "2026-06-11T14-00-00Z", "generation-log.txt"), "utf8");
    expect(log).toContain("Shipped 1");
    expect(log).toContain("model: opus");
  });

  test("a zero-artifact agent run is valid (created empty, exit surfaced)", async () => {
    const spawn: SpawnFn = () => ({ status: 0, stdout: "Killed: none. Nothing cleared the bar.", stderr: "" });
    const summary = await runGeneration({
      briefPath,
      artifactsDir,
      cap: 3,
      repoRoot: dir,
      spawn,
      env: {},
    });
    expect(summary.created).toEqual([]);
    expect(summary.killed).toEqual([]);
    expect(summary.exit_code).toBe(0);
  });

  test("model override flows to the argv", async () => {
    let seen: string[] = [];
    const spawn: SpawnFn = (_c, args) => {
      seen = args;
      return { status: 0, stdout: "", stderr: "" };
    };
    await runGeneration({ briefPath, artifactsDir, model: "sonnet", repoRoot: dir, spawn, env: {} });
    expect(seen[seen.indexOf("--model") + 1]).toBe("sonnet");
    // env override when no flag:
    await runGeneration({ briefPath, artifactsDir, repoRoot: dir, spawn, env: { MEET_GEN_MODEL: "haiku" } });
    expect(seen[seen.indexOf("--model") + 1]).toBe("haiku");
  });
});

// ===========================================================================
// 4b. DETERMINISTIC CAP ENFORCEMENT (review Medium #3 — cap is structural, not
//     just prompt text) + IN-RUN DEDUP (Hunter-approved core upgrade).
// ===========================================================================

/** Write a fake published artifact under <artifactsDir>/<type>/<slug>/. */
async function writeArtifact(
  artifactsDir: string,
  type: string,
  slug: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  const d = join(artifactsDir, type, slug);
  await mkdir(d, { recursive: true });
  await writeFile(
    join(d, "artifact.json"),
    JSON.stringify({ id: slug, type, headline: slug, tags: [], source_transcripts: [], generated_at: "2026-06-11T14:00:00.000Z", quality: { critic_pass: true, quotes_verified: true }, ...body }),
  );
}

describe("enforceCap — deterministic over-cap quarantine", () => {
  let dir: string;
  let artifactsDir: string;
  let qroot: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cap-"));
    artifactsDir = join(dir, "artifacts");
    qroot = join(dir, "runs", "r1");
    await mkdir(qroot, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("agent produces N+2 → only N remain in artifacts/, 2 quarantined", async () => {
    // 5 created artifacts, cap 3. Distinct generated_at so creation order is stable.
    const stamps = [
      "2026-06-11T14:00:01.000Z",
      "2026-06-11T14:00:02.000Z",
      "2026-06-11T14:00:03.000Z",
      "2026-06-11T14:00:04.000Z",
      "2026-06-11T14:00:05.000Z",
    ];
    for (let i = 0; i < 5; i++) {
      await writeArtifact(artifactsDir, "insight-card", `c${i}`, { generated_at: stamps[i] });
    }
    const created = await scanArtifacts(artifactsDir);
    expect(created.length).toBe(5);

    const res = await enforceCap(created, 3, qroot);
    expect(res.kept.length).toBe(3);
    expect(res.quarantined.length).toBe(2);

    // The first 3 by creation order stay published; the last 2 are gone from artifacts/.
    const remaining = await scanArtifacts(artifactsDir);
    expect(remaining.map((r) => r.slug).sort()).toEqual(["c0", "c1", "c2"]);
    // The excess landed in the over-cap quarantine, not deleted.
    const quarantined = await scanArtifacts(join(qroot, "over-cap"));
    expect(quarantined.map((r) => r.slug).sort()).toEqual(["c3", "c4"]);
  });

  test("at/under cap is a no-op", async () => {
    await writeArtifact(artifactsDir, "article", "a0");
    await writeArtifact(artifactsDir, "article", "a1");
    const created = await scanArtifacts(artifactsDir);
    const res = await enforceCap(created, 3, qroot);
    expect(res.quarantined).toEqual([]);
    expect((await scanArtifacts(artifactsDir)).length).toBe(2);
  });
});

describe("in-run dedup — one signal → one artifact across formats", () => {
  let dir: string;
  let artifactsDir: string;
  let qroot: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dedup-"));
    artifactsDir = join(dir, "artifacts");
    qroot = join(dir, "runs", "r1");
    await mkdir(qroot, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("sameSignal: same source + overlapping novelty lead → true; distinct → false", async () => {
    const a = { sources: ["fundraise.md"], lead: "the 2m to 100k fundraise drift quantified claim" };
    const b = { sources: ["fundraise.md"], lead: "fundraise drift from 2m to 100k underlying signal" };
    const c = { sources: ["fundraise.md"], lead: "hiring plan timeline single voice topic" };
    const d = { sources: ["other.md"], lead: "the 2m to 100k fundraise drift quantified claim" };
    expect(sameSignal(a, b)).toBe(true); // shared source + overlapping lead
    expect(sameSignal(a, c)).toBe(false); // shared source, DIFFERENT lead → distinct angle
    expect(sameSignal(a, d)).toBe(false); // same lead but DIFFERENT source → not the same signal
  });

  test("a card AND a podcast on the SAME signal → only one ships, the dup is quarantined", async () => {
    // The observed bug: a card + a podcast both on the "$2M→100k fundraise drift".
    await writeArtifact(artifactsDir, "insight-card", "fundraise-drift-card", {
      source_transcripts: ["/corpus/fundraise.md"],
      novelty: 0.7,
      quality: { critic_pass: true, quotes_verified: true, notes: "novelty: the 2M to 100k fundraise drift across three standups" },
    });
    await writeArtifact(artifactsDir, "podcast", "fundraise-drift-pod", {
      source_transcripts: ["/corpus/fundraise.md"],
      novelty: 0.9,
      quality: { critic_pass: true, quotes_verified: true, notes: "novelty: fundraise drift from 2M down to 100k underlying signal" },
    });
    // A genuinely DISTINCT artifact on a different signal — must survive.
    await writeArtifact(artifactsDir, "insight-card", "hiring-card", {
      source_transcripts: ["/corpus/standup.md"],
      novelty: 0.6,
      quality: { critic_pass: true, quotes_verified: true, notes: "novelty: hiring plan timeline single voice topic" },
    });

    const created = await scanArtifacts(artifactsDir);
    expect(created.length).toBe(3);

    const res = await dedupBySignal(created, qroot);
    // Two same-signal artifacts → ONE survives (the higher-novelty podcast, 0.9 > 0.7).
    expect(res.quarantined.length).toBe(1);
    expect(res.quarantined[0]!.slug).toBe("fundraise-drift-card");
    expect(res.kept.map((r) => r.slug).sort()).toEqual(["fundraise-drift-pod", "hiring-card"]);

    // The dup is gone from artifacts/ and quarantined (not deleted).
    const remaining = await scanArtifacts(artifactsDir);
    expect(remaining.map((r) => r.slug).sort()).toEqual(["fundraise-drift-pod", "hiring-card"]);
    const dq = await scanArtifacts(join(qroot, "dedup"));
    expect(dq.map((r) => r.slug)).toEqual(["fundraise-drift-card"]);
  });

  test("distinct signals all ship (no false-positive quarantine)", async () => {
    await writeArtifact(artifactsDir, "insight-card", "a", {
      source_transcripts: ["/corpus/x.md"],
      quality: { critic_pass: true, quotes_verified: true, notes: "novelty: pricing strategy reversal signal" },
    });
    await writeArtifact(artifactsDir, "article", "b", {
      source_transcripts: ["/corpus/y.md"],
      quality: { critic_pass: true, quotes_verified: true, notes: "novelty: onboarding funnel drop off" },
    });
    const created = await scanArtifacts(artifactsDir);
    const res = await dedupBySignal(created, qroot);
    expect(res.quarantined).toEqual([]);
    expect(res.kept.length).toBe(2);
  });

  test("readSignalFingerprint normalizes sources to basenames + lowercases the lead", async () => {
    await writeArtifact(artifactsDir, "insight-card", "f", {
      source_transcripts: ["/abs/path/To/Fundraise.MD"],
      quality: { critic_pass: true, quotes_verified: true, notes: "Novelty: The DRIFT" },
    });
    const fp = await readSignalFingerprint(join(artifactsDir, "insight-card", "f"));
    expect(fp.sources).toEqual(["fundraise.md"]);
    expect(fp.lead).toContain("drift");
  });
});

describe("runGeneration end-to-end — dedup + cap backstops fire", () => {
  let dir: string;
  let artifactsDir: string;
  let briefPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "run-gen-backstop-"));
    artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const runDir = join(dir, "runs", "2026-06-11T14-00-00Z");
    await mkdir(runDir, { recursive: true });
    briefPath = join(runDir, "run-brief.md");
    await writeFile(briefPath, "# brief\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a non-compliant agent that writes a dup + over-cap → only survivors in summary.created", async () => {
    // Agent writes 4 artifacts: 2 on the same signal (dup) + 2 distinct. cap=2.
    // After dedup (1 dup removed) → 3 distinct; after cap=2 → 1 more quarantined.
    const spawn: SpawnFn = () => {
      const fs = require("node:fs");
      const mk = (type: string, slug: string, body: Record<string, unknown>) => {
        const d = join(artifactsDir, type, slug);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(join(d, "artifact.json"), JSON.stringify({ id: slug, type, headline: slug, tags: [], generated_at: body.generated_at ?? "2026-06-11T14:00:00.000Z", quality: { critic_pass: true, quotes_verified: true }, ...body }));
      };
      mk("insight-card", "drift-card", { generated_at: "2026-06-11T14:00:01.000Z", source_transcripts: ["/c/f.md"], novelty: 0.5, quality: { critic_pass: true, quotes_verified: true, notes: "novelty: fundraise drift 2m to 100k signal" } });
      mk("podcast", "drift-pod", { generated_at: "2026-06-11T14:00:02.000Z", source_transcripts: ["/c/f.md"], novelty: 0.9, quality: { critic_pass: true, quotes_verified: true, notes: "novelty: fundraise drift from 2m to 100k signal" } });
      mk("insight-card", "topic-x", { generated_at: "2026-06-11T14:00:03.000Z", source_transcripts: ["/c/x.md"], novelty: 0.8, quality: { critic_pass: true, quotes_verified: true, notes: "novelty: pricing reversal distinct topic" } });
      mk("insight-card", "topic-y", { generated_at: "2026-06-11T14:00:04.000Z", source_transcripts: ["/c/y.md"], novelty: 0.4, quality: { critic_pass: true, quotes_verified: true, notes: "novelty: onboarding funnel distinct topic" } });
      return { status: 0, stdout: "shipped 4", stderr: "" };
    };

    const summary = await runGeneration({
      briefPath,
      artifactsDir,
      cap: 2,
      repoRoot: dir,
      runId: "2026-06-11T14:00:00Z",
      spawn,
      env: {},
    });

    // dup-signal card quarantined + 1 over-cap → 2 published survivors.
    expect(summary.created.length).toBe(2);
    expect(summary.quarantined?.length).toBe(2);
    const reasons = (summary.quarantined ?? []).map((q) => q.reason).sort();
    expect(reasons).toEqual(["duplicate-signal", "over-cap"]);
    // The dedup winner (higher-novelty pod) is among survivors; the dup card is not.
    const slugs = summary.created.map((c) => c.slug);
    expect(slugs).toContain("drift-pod");
    expect(slugs).not.toContain("drift-card");

    // artifacts/ on disk matches the summary (2 published).
    const onDisk = await scanArtifacts(artifactsDir);
    expect(onDisk.length).toBe(2);
  });
});

// ===========================================================================
// 5. feed-run wiring (FAKE claude on PATH — dry-run skips, real run invokes)
// ===========================================================================

interface WireCtx {
  dir: string;
  transcriptsDir: string;
  binDir: string;
  indexPath: string;
  ledgerPath: string;
  runsDir: string;
  runLogPath: string;
  prefsPath: string;
  artifactsDir: string;
}

async function writeTranscript(d: string, name: string, date: string, body: string): Promise<void> {
  await writeFile(
    join(d, name),
    `# ${name.replace(/\.md$/, "")}\n**Date:** ${date}\n\n**Ada:** ${body}\n\n**Grace:** Agreed, ${body}\n`,
  );
}

/** A fake `claude` on PATH: records that it was invoked, never reasons. */
async function installFakeClaude(binDir: string, markerFile: string, mode: "noop" | "create" = "noop"): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const create =
    mode === "create"
      ? `
const nodePath = require("node:path");
// Simulate the agent writing one artifact under the repo's artifacts dir.
const artDir = process.env.FAKE_CLAUDE_ARTIFACTS;
if (artDir) {
  const d = nodePath.join(artDir, "insight-card", "fake-created");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(nodePath.join(d, "artifact.json"), JSON.stringify({ novelty: 0.7 }));
}
`
      : "";
  const script = `#!/usr/bin/env bun
const fs = require("node:fs");
// Record the argv so the test can prove claude -p was invoked.
fs.writeFileSync(process.env.FAKE_CLAUDE_MARKER, JSON.stringify(process.argv.slice(2)));
${create}
process.stdout.write("Shipped from fake claude. Killed: none\\n");
process.exit(0);
`;
  const p = join(binDir, "claude");
  await writeFile(p, script);
  await chmod(p, 0o755);
  void markerFile;
}

function runFeedRun(
  ctx: WireCtx,
  extraArgs: string[],
  extraEnv: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(
    "bun",
    [
      "skills/feed-run/scripts/feed-run.ts",
      "--index-path",
      ctx.indexPath,
      "--ledger",
      ctx.ledgerPath,
      "--runs-dir",
      ctx.runsDir,
      "--run-log",
      ctx.runLogPath,
      "--preferences",
      ctx.prefsPath,
      "--artifacts-dir",
      ctx.artifactsDir,
      ...extraArgs,
    ],
    {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        // Put the fake claude FIRST on PATH so the runner spawns it, not the real CLI.
        PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
        TRANSCRIPT_DIRS: ctx.transcriptsDir,
        FAKE_CLAUDE_MARKER: join(ctx.dir, "claude-invoked.json"),
        FAKE_CLAUDE_ARTIFACTS: ctx.artifactsDir,
        ...extraEnv,
      },
    },
  );
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

async function claudeWasInvoked(ctx: WireCtx): Promise<string[] | null> {
  try {
    return JSON.parse(await readFile(join(ctx.dir, "claude-invoked.json"), "utf8"));
  } catch {
    return null;
  }
}

describe("feed-run wiring (fake claude on PATH — no real agent/model)", () => {
  let ctx: WireCtx;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "feed-wire-"));
    const transcriptsDir = join(dir, "Fireflies-Transcripts");
    await mkdir(transcriptsDir, { recursive: true });
    ctx = {
      dir,
      transcriptsDir,
      binDir: join(dir, "bin"),
      indexPath: join(dir, "corpus-index.json"),
      ledgerPath: join(dir, "surfaced.json"),
      runsDir: join(dir, "runs"),
      runLogPath: join(dir, "run-log.jsonl"),
      prefsPath: join(dir, "PREFERENCES.md"),
      artifactsDir: join(dir, "artifacts"),
    };
    await writeFile(ctx.prefsPath, "- [learned] synthetic preference panel\n");
    await writeTranscript(transcriptsDir, "recent-a.md", "2026-06-09", "we shipped OpenKey delegation");
    await writeTranscript(transcriptsDir, "old-a.md", "2026-04-02", "early OpenKey idea worth ten dollars");
  });
  afterEach(async () => {
    await rm(ctx.dir, { recursive: true, force: true });
  });

  test("--dry-run does NOT invoke claude (stops at the brief)", async () => {
    await installFakeClaude(ctx.binDir, "");
    const { status, stdout } = runFeedRun(ctx, ["--dry-run", "--since", "2026-06-07"]);
    expect(status).toBe(0);
    expect(stdout).toContain("# Feed-run brief");
    // The fake claude was never spawned.
    expect(await claudeWasInvoked(ctx)).toBeNull();
  });

  test("--no-generate does NOT invoke claude but DOES persist the cursor (dry preview)", async () => {
    await installFakeClaude(ctx.binDir, "");
    const { status } = runFeedRun(ctx, ["--no-generate", "--since", "2026-06-07"]);
    expect(status).toBe(0);
    expect(await claudeWasInvoked(ctx)).toBeNull(); // no generation
    // Cursor persisted (unlike --dry-run): a ledger file now exists with a cursor.
    const ledger = JSON.parse(await readFile(ctx.ledgerPath, "utf8"));
    expect(ledger.deepdive_cursor.last_path).toBeDefined();
    expect(ledger.surfaced).toEqual([]); // no surfaced entries (no agent ran)
    // The generate step is logged as skipped.
    const logs = (await readFile(ctx.runLogPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const gen = logs[0].steps.find((s: { step: string }) => s.step === "generate");
    expect(gen.status).toBe("skipped");
    expect(gen.detail).toContain("--no-generate");
  });

  test("a real run INVOKES claude -p and records the published artifact", async () => {
    await installFakeClaude(ctx.binDir, "", "create");
    const { status, stderr } = runFeedRun(ctx, ["--since", "2026-06-07"]);
    expect(status).toBe(0);
    // claude -p was invoked with the headless recipe.
    const argv = await claudeWasInvoked(ctx);
    expect(argv).not.toBeNull();
    expect(argv![0]).toBe("-p");
    expect(argv).toContain("--system-prompt");
    expect(argv![argv!.indexOf("--model") + 1]).toBe("opus");
    // The run log records the generate step as ok and the published artifact.
    const logs = (await readFile(ctx.runLogPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const log = logs[0];
    expect(log.artifacts_published).toContain("insight-card/fake-created");
    const gen = log.steps.find((s: { step: string }) => s.step === "generate");
    expect(gen.status).toBe("ok");
    // A generation-log.txt was captured in the run dir.
    const runDir = join(ctx.runsDir, log.run_id.replace(/[:]/g, "-"));
    expect(await readFile(join(runDir, "generation-log.txt"), "utf8")).resolves !== undefined;
    void stderr;
  });

  test("--model flows through to the headless invocation", async () => {
    await installFakeClaude(ctx.binDir, "");
    const { status } = runFeedRun(ctx, ["--since", "2026-06-07", "--model", "sonnet"]);
    expect(status).toBe(0);
    const argv = await claudeWasInvoked(ctx);
    expect(argv![argv!.indexOf("--model") + 1]).toBe("sonnet");
  });

  test("$MEET_GEN_MODEL overrides the default when no --model flag", async () => {
    await installFakeClaude(ctx.binDir, "");
    const { status } = runFeedRun(ctx, ["--since", "2026-06-07"], { MEET_GEN_MODEL: "haiku" });
    expect(status).toBe(0);
    const argv = await claudeWasInvoked(ctx);
    expect(argv![argv!.indexOf("--model") + 1]).toBe("haiku");
  });
});
