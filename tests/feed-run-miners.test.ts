// feed-run-miners.test.ts — Phase 1b MINER WIRING (the harness change).
//
// What this proves, all WITHOUT calling claude or generating:
//   1. The SALIENT-PEOPLE detector — synthetic index fixture → correct candidates,
//      threshold honored, already-briefed people excluded, ranking stable, top-N.
//   2. PUBLISHED vs DRAFT routing — outward drafts (social-post / investor-update-
//      snippet) do NOT count against the published cap; internal artifacts
//      (incl. person-brief) DO. The cap/dedup backstops still hold over published.
//   3. The generation prompt + the run-brief now REFERENCE the new miner skills
//      (banger-extractor, investor-snippet, person-brief) as drafts/salience —
//      and say outward drafts are pending, not published.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import type { IndexRecord, CorpusIndex } from "../harness/index-corpus/scripts/corpus-index.ts";
import {
  detectSalientPeople,
  findSalientPeople,
  tallySpeakers,
  existingBriefSlugs,
  summarizeSalient,
  DEFAULT_SALIENCE_MIN_TRANSCRIPTS,
} from "../harness/feed-run/scripts/salient-people-lib.ts";
import {
  partitionByRouting,
  isDraftAudience,
  readAudience,
  enforceCap,
  dedupBySignal,
  scanArtifacts,
  buildSystemPrompt,
  buildSummary,
  summarizeGeneration,
  type ArtifactRef,
  type GenInvocationInput,
} from "../harness/feed-run/scripts/run-generation-lib.ts";
import { renderBrief } from "../harness/feed-run/scripts/feed-run-lib.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function rec(over: Partial<IndexRecord> & { path: string }): IndexRecord {
  return {
    source: "fireflies",
    speakers: [],
    speakerTurnCounts: {},
    turnCount: 0,
    entities: [],
    terms: [],
    quantities: [],
    content_hash: "sha256:x",
    indexed_at: "2026-06-10T00:00:00Z",
    empty: false,
    ...over,
  };
}

/** A synthetic corpus: Alice speaks in 3 transcripts, Carol in 3, Bob in 1, Dora in 2. */
function syntheticRecords(): IndexRecord[] {
  return [
    rec({ path: "/c/a.md", speakerTurnCounts: { Alice: 10, Bob: 3 }, speakers: ["Alice", "Bob"] }),
    rec({ path: "/c/b.md", speakerTurnCounts: { Alice: 5, Carol: 8, Dora: 2 }, speakers: ["Alice", "Carol", "Dora"] }),
    rec({ path: "/c/c.md", speakerTurnCounts: { Alice: 2, Carol: 4, Dora: 1 }, speakers: ["Alice", "Carol", "Dora"] }),
    rec({ path: "/c/d.md", speakerTurnCounts: { Carol: 1 }, speakers: ["Carol"] }),
    // an EMPTY transcript must contribute nothing even if it names a speaker.
    rec({ path: "/c/empty.md", empty: true, speakerTurnCounts: { Alice: 99 }, speakers: ["Alice"] }),
  ];
}

// ===========================================================================
// 1. the salient-people detector
// ===========================================================================

describe("tallySpeakers", () => {
  test("counts DISTINCT transcripts + total turns; empty transcripts ignored", () => {
    const t = tallySpeakers(syntheticRecords());
    expect(t.get("Alice")).toEqual({ transcriptCount: 3, turnCount: 17 }); // empty.md NOT counted
    expect(t.get("Carol")).toEqual({ transcriptCount: 3, turnCount: 13 });
    expect(t.get("Bob")).toEqual({ transcriptCount: 1, turnCount: 3 });
    expect(t.get("Dora")).toEqual({ transcriptCount: 2, turnCount: 3 });
  });
});

describe("detectSalientPeople (pure core)", () => {
  test("threshold >=3 surfaces Alice + Carol; Bob (1) + Dora (2) below the bar", () => {
    const people = detectSalientPeople(syntheticRecords(), { minTranscripts: 3 });
    expect(people.map((p) => p.name)).toEqual(["Alice", "Carol"]); // Alice 17 turns > Carol 13
  });

  test("EXCLUDES people who already have a current person-brief", () => {
    const people = detectSalientPeople(syntheticRecords(), {
      minTranscripts: 3,
      alreadyBriefed: new Set(["carol"]), // slugify("Carol")
    });
    expect(people.map((p) => p.name)).toEqual(["Alice"]);
  });

  test("ranking is transcriptCount desc, then turnCount desc, then name", () => {
    // Lower the bar so Dora (2) joins; tie Carol/Dora-style ordering is exercised.
    const people = detectSalientPeople(syntheticRecords(), { minTranscripts: 2 });
    // Alice(3,17), Carol(3,13) then Dora(2,3).
    expect(people.map((p) => p.name)).toEqual(["Alice", "Carol", "Dora"]);
  });

  test("top-N caps the candidate list", () => {
    const people = detectSalientPeople(syntheticRecords(), { minTranscripts: 2, top: 1 });
    expect(people).toHaveLength(1);
    expect(people[0]!.name).toBe("Alice");
  });

  test("default threshold is 3", () => {
    expect(DEFAULT_SALIENCE_MIN_TRANSCRIPTS).toBe(3);
    const people = detectSalientPeople(syntheticRecords());
    expect(people.map((p) => p.name)).toEqual(["Alice", "Carol"]);
  });
});

describe("existingBriefSlugs + findSalientPeople (filesystem)", () => {
  let dir: string;
  let artifactsDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "salient-"));
    artifactsDir = join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("missing person-brief dir → empty set (never throws)", async () => {
    expect((await existingBriefSlugs(artifactsDir)).size).toBe(0);
  });

  test("only folders WITH an artifact.json count as briefed", async () => {
    await mkdir(join(artifactsDir, "person-brief", "alice"), { recursive: true });
    await writeFile(join(artifactsDir, "person-brief", "alice", "artifact.json"), "{}");
    // a stray folder with no artifact.json is NOT a current brief
    await mkdir(join(artifactsDir, "person-brief", "stray"), { recursive: true });
    const slugs = await existingBriefSlugs(artifactsDir);
    expect([...slugs].sort()).toEqual(["alice"]);
  });

  test("findSalientPeople end-to-end: already-briefed Alice drops, Carol surfaces", async () => {
    await mkdir(join(artifactsDir, "person-brief", "alice"), { recursive: true });
    await writeFile(join(artifactsDir, "person-brief", "alice", "artifact.json"), "{}");
    const index: CorpusIndex = {
      version: 1,
      generated_at: "x",
      transcript_dirs: [],
      transcripts: syntheticRecords(),
      warnings: [],
    };
    const people = await findSalientPeople(index, artifactsDir, { minTranscripts: 3 });
    expect(people.map((p) => p.name)).toEqual(["Carol"]); // Alice already briefed
  });
});

describe("summarizeSalient", () => {
  test("empty → no-salient line; non-empty → counts + names", () => {
    expect(summarizeSalient([], 3)).toContain("no salient");
    const s = summarizeSalient(
      [{ name: "Alice", slug: "alice", transcriptCount: 4, turnCount: 9 }],
      3,
    );
    expect(s).toContain("Alice(4)");
    expect(s).toContain("1 salient");
  });
});

// ===========================================================================
// 2. PUBLISHED vs DRAFT routing — the cap counts published only
// ===========================================================================

/** Write a fake artifact with a given type + (optional) audience. */
async function writeArt(
  artifactsDir: string,
  type: string,
  slug: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  const d = join(artifactsDir, type, slug);
  await mkdir(d, { recursive: true });
  await writeFile(
    join(d, "artifact.json"),
    JSON.stringify({
      id: slug,
      type,
      headline: slug,
      tags: [],
      source_transcripts: ["/c/x.md"],
      generated_at: "2026-06-11T14:00:00.000Z",
      quality: { critic_pass: true, quotes_verified: true },
      ...body,
    }),
  );
}

describe("isDraftAudience + readAudience", () => {
  test("public/investors are drafts; internal/undefined are published", () => {
    expect(isDraftAudience("public")).toBe(true);
    expect(isDraftAudience("investors")).toBe(true);
    expect(isDraftAudience("internal")).toBe(false);
    expect(isDraftAudience(undefined)).toBe(false);
  });

  test("readAudience reads the stamped audience; missing → undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aud-"));
    await writeArt(dir, "social-post", "banger", { audience: "public" });
    await writeArt(dir, "insight-card", "card"); // no audience
    expect(await readAudience(join(dir, "social-post", "banger"))).toBe("public");
    expect(await readAudience(join(dir, "insight-card", "card"))).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("partitionByRouting", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "partition-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("outward drafts split from published; person-brief (internal) publishes", async () => {
    await writeArt(dir, "insight-card", "card"); // internal → published
    await writeArt(dir, "person-brief", "alice", { audience: "internal" }); // internal → published
    await writeArt(dir, "social-post", "banger", { audience: "public" }); // draft
    await writeArt(dir, "investor-update-snippet", "snip", { audience: "investors" }); // draft
    const created = await scanArtifacts(dir);
    const { published, drafts } = await partitionByRouting(created);
    expect(published.map((r) => r.type).sort()).toEqual(["insight-card", "person-brief"]);
    expect(drafts.map((r) => r.type).sort()).toEqual([
      "investor-update-snippet",
      "social-post",
    ]);
  });
});

describe("cap counts PUBLISHED only — drafts never crowd out feed artifacts", () => {
  let dir: string;
  let artifactsDir: string;
  let qroot: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cap-routing-"));
    artifactsDir = join(dir, "artifacts");
    qroot = join(dir, "runs", "r1");
    await mkdir(qroot, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("3 published + 2 drafts, cap 3 → all 3 published kept, both drafts pass", async () => {
    const stamps = [
      "2026-06-11T14:00:01.000Z",
      "2026-06-11T14:00:02.000Z",
      "2026-06-11T14:00:03.000Z",
    ];
    await writeArt(artifactsDir, "insight-card", "c0", { generated_at: stamps[0] });
    await writeArt(artifactsDir, "article", "c1", { generated_at: stamps[1] });
    await writeArt(artifactsDir, "person-brief", "alice", { generated_at: stamps[2], audience: "internal" });
    await writeArt(artifactsDir, "social-post", "banger", { audience: "public" });
    await writeArt(artifactsDir, "investor-update-snippet", "snip", { audience: "investors" });

    const created = await scanArtifacts(artifactsDir);
    const { published, drafts } = await partitionByRouting(created);
    // Drafts do NOT enter cap enforcement.
    const capped = await enforceCap(published, 3, qroot);
    expect(capped.kept.length).toBe(3);
    expect(capped.quarantined.length).toBe(0); // 3 published == cap, nothing over
    expect(drafts.length).toBe(2);
  });

  test("4 published, cap 3 → 1 over-cap quarantined (cap still bites for published)", async () => {
    const stamps = [
      "2026-06-11T14:00:01.000Z",
      "2026-06-11T14:00:02.000Z",
      "2026-06-11T14:00:03.000Z",
      "2026-06-11T14:00:04.000Z",
    ];
    for (let i = 0; i < 4; i++) {
      await writeArt(artifactsDir, "insight-card", `c${i}`, { generated_at: stamps[i] });
    }
    const created = await scanArtifacts(artifactsDir);
    const { published } = await partitionByRouting(created);
    const capped = await enforceCap(published, 3, qroot);
    expect(capped.kept.length).toBe(3);
    expect(capped.quarantined.length).toBe(1);
  });

  // UNIT test of the dedup CONTRACT over an already-published set (the safe input).
  // It does NOT guard the production ORDERING — run-generation.ts must partition
  // BEFORE calling dedupBySignal so a draft never competes. That ordering is
  // regression-tested end-to-end in run-generation.test.ts ("a high-novelty DRAFT
  // same-signal as a card → the CARD survives"), which drives runGeneration itself.
  test("dedup still holds over published (same-signal card + podcast → one survives)", async () => {
    await writeArt(artifactsDir, "insight-card", "drift-card", {
      novelty: 0.7,
      quality: { critic_pass: true, quotes_verified: true, notes: "novelty: the 2m to 100k fundraise drift signal" },
    });
    await writeArt(artifactsDir, "podcast", "drift-pod", {
      novelty: 0.9,
      quality: { critic_pass: true, quotes_verified: true, notes: "novelty: fundraise drift from 2m to 100k signal" },
    });
    const created = await scanArtifacts(artifactsDir);
    const { published } = await partitionByRouting(created);
    const res = await dedupBySignal(published, qroot);
    expect(res.quarantined.length).toBe(1);
    expect(res.kept.map((r) => r.slug)).toContain("drift-pod");
  });
});

describe("buildSummary + summarizeGeneration carry drafts separately", () => {
  test("drafts surface in the summary but not in created (the published list)", () => {
    const s = buildSummary({
      created: [{ type: "person-brief", slug: "alice" }],
      drafts: [{ type: "social-post", slug: "banger" }],
      stdout: "shipped",
      duration: 10,
      exitCode: 0,
    });
    expect(s.created.map((c) => c.type)).toEqual(["person-brief"]);
    expect(s.drafts?.map((c) => c.type)).toEqual(["social-post"]);
    const line = summarizeGeneration(s);
    expect(line).toContain("created=1");
    expect(line).toContain("drafts=1");
    expect(line).toContain("social-post/banger");
  });

  test("no drafts → no drafts field (the common run)", () => {
    const s = buildSummary({ created: [], stdout: "", duration: 1, exitCode: 0 });
    expect(s.drafts).toBeUndefined();
    expect(summarizeGeneration(s)).not.toContain("drafts=");
  });
});

// ===========================================================================
// 3. the prompt + the brief now REFERENCE the new miner skills
// ===========================================================================

function invInput(over: Partial<GenInvocationInput> = {}): GenInvocationInput {
  return {
    briefPath: "/abs/runs/r1/run-brief.md",
    repoRoot: "/abs/repo",
    artifactsDir: "/abs/repo/artifacts",
    cap: 3,
    model: "opus",
    runId: "r1",
    ...over,
  };
}

describe("generation system prompt references the new miners", () => {
  const sp = buildSystemPrompt(invInput());

  test("names banger-extractor + investor-snippet as OUTWARD DRAFTS (pending, not published)", () => {
    expect(sp).toContain("banger-extractor");
    expect(sp).toContain("investor-snippet");
    expect(sp).toContain("social-post");
    expect(sp).toContain("investor-update-snippet");
    expect(sp).toMatch(/pending/i);
    expect(sp).toMatch(/DRAFT/i);
    expect(sp).toMatch(/do NOT count against the published|do NOT count against the cap/i);
  });

  test("names person-brief on salience (internal — publishes, counts against cap)", () => {
    expect(sp).toContain("person-brief");
    expect(sp).toMatch(/SALIENT PEOPLE|salient/i);
    expect(sp).toMatch(/internal/);
    expect(sp).toMatch(/COUNTS against the cap|counts against the cap/i);
    expect(sp).toMatch(/identity-grounding|no role|fabricat/i);
  });

  test("still references the internal feed miners + the critic + cap (no regression)", () => {
    expect(sp).toContain("extract-insights");
    expect(sp).toContain("write-article");
    expect(sp).toContain("make-podcast");
    expect(sp).toContain("adversarial");
    expect(sp).toMatch(/cap.*3|3.*cap|MAX_ARTIFACTS_PER_RUN.*3/);
  });
});

describe("run-brief references the new miners + lists salient people", () => {
  test("brief with salient people lists them + the outward-draft + person-brief guidance", () => {
    const md = renderBrief({
      runId: "r1",
      mode: "daily",
      since: "2026-06-01",
      cap: 3,
      recency: [],
      deepDiveWrapped: false,
      preferences: "- panel",
      distillDegraded: false,
      baselineSummary: "0 prior",
      salientPeople: [{ name: "Ada Lovelace", slug: "ada-lovelace", transcriptCount: 4, turnCount: 20 }],
    });
    // Outward drafts referenced + flagged pending/not-published.
    expect(md).toContain("banger-extractor");
    expect(md).toContain("investor-snippet");
    expect(md).toContain("approval_status");
    expect(md).toMatch(/approvals tray/i);
    // Salient-people section lists the candidate.
    expect(md).toContain("Salient people");
    expect(md).toContain("Ada Lovelace");
    expect(md).toContain("ada-lovelace");
    expect(md).toContain("person-brief");
  });

  test("brief with NO salient people says do NOT generate a person-brief", () => {
    const md = renderBrief({
      runId: "r1",
      mode: "daily",
      since: "2026-06-01",
      cap: 3,
      recency: [],
      deepDiveWrapped: false,
      preferences: "- panel",
      distillDegraded: false,
      baselineSummary: "0 prior",
      salientPeople: [],
    });
    expect(md).toContain("Salient people");
    expect(md).toMatch(/none[\s\S]*person-brief|do NOT generate a person-brief/i);
  });
});

// ===========================================================================
// 4. end-to-end wiring (FAKE claude on PATH): the run-log records DRAFTS produced
//    vs PUBLISHED artifacts, and a published cap is unaffected by drafts.
// ===========================================================================

const REPO = join(import.meta.dir, "..");

/**
 * A fake `claude` that writes ONE published insight-card AND ONE outward draft
 * (social-post, audience public, approval_status pending). Proves the harness
 * routes the draft to drafts_produced, NOT artifacts_published.
 */
async function installFakeClaudeWithDraft(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const script = `#!/usr/bin/env bun
const fs = require("node:fs");
const nodePath = require("node:path");
fs.writeFileSync(process.env.FAKE_CLAUDE_MARKER, JSON.stringify(process.argv.slice(2)));
const artDir = process.env.FAKE_CLAUDE_ARTIFACTS;
const writeArt = (type, slug, body) => {
  const d = nodePath.join(artDir, type, slug);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(nodePath.join(d, "artifact.json"), JSON.stringify({
    id: slug, type, headline: slug, tags: [], source_transcripts: ["/c/x.md"],
    generated_at: "2026-06-11T14:00:00.000Z",
    quality: { critic_pass: true, quotes_verified: true }, ...body,
  }));
};
writeArt("insight-card", "feed-card", {});                                  // published
writeArt("social-post", "earned-secret", { audience: "public", approval_status: "pending" }); // DRAFT
process.stdout.write("Shipped 1 card + 1 draft. Killed: none\\n");
process.exit(0);
`;
  const p = join(binDir, "claude");
  await writeFile(p, script);
  await chmod(p, 0o755);
}

async function writeWireTranscript(d: string, name: string, date: string, body: string): Promise<void> {
  await writeFile(
    join(d, name),
    `# ${name.replace(/\.md$/, "")}\n**Date:** ${date}\n\n**Ada:** ${body}\n\n**Grace:** Agreed, ${body}\n`,
  );
}

describe("feed-run wiring: run-log records drafts produced vs published", () => {
  let dir: string;
  let ctx: {
    transcriptsDir: string;
    binDir: string;
    indexPath: string;
    ledgerPath: string;
    runsDir: string;
    runLogPath: string;
    prefsPath: string;
    artifactsDir: string;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "feed-miner-wire-"));
    const transcriptsDir = join(dir, "Fireflies-Transcripts");
    await mkdir(transcriptsDir, { recursive: true });
    ctx = {
      transcriptsDir,
      binDir: join(dir, "bin"),
      indexPath: join(dir, "corpus-index.json"),
      ledgerPath: join(dir, "surfaced.json"),
      runsDir: join(dir, "runs"),
      runLogPath: join(dir, "run-log.jsonl"),
      prefsPath: join(dir, "PREFERENCES.md"),
      artifactsDir: join(dir, "artifacts"),
    };
    await writeFile(ctx.prefsPath, "- human authored panel line\n");
    await writeWireTranscript(transcriptsDir, "recent-a.md", "2026-06-09", "we shipped OpenKey delegation");
    await writeWireTranscript(transcriptsDir, "old-a.md", "2026-04-02", "early OpenKey idea worth ten dollars");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a draft-producing run records the draft separately and does NOT publish it", async () => {
    await installFakeClaudeWithDraft(ctx.binDir);
    const res = spawnSync(
      "bun",
      [
        "harness/feed-run/scripts/feed-run.ts",
        "--index-path", ctx.indexPath,
        "--ledger", ctx.ledgerPath,
        "--runs-dir", ctx.runsDir,
        "--run-log", ctx.runLogPath,
        "--preferences", ctx.prefsPath,
        "--artifacts-dir", ctx.artifactsDir,
        "--since", "2026-06-07",
      ],
      {
        cwd: REPO,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
          TRANSCRIPT_DIRS: ctx.transcriptsDir,
          FAKE_CLAUDE_MARKER: join(dir, "claude-invoked.json"),
          FAKE_CLAUDE_ARTIFACTS: ctx.artifactsDir,
        },
      },
    );
    expect(res.status).toBe(0);

    const logs = (await readFile(ctx.runLogPath, "utf8"))
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const log = logs[0];
    // The insight-card PUBLISHED; the social-post is a DRAFT (not published).
    expect(log.artifacts_published).toContain("insight-card/feed-card");
    expect(log.artifacts_published).not.toContain("social-post/earned-secret");
    expect(log.drafts_produced).toContain("social-post/earned-secret");
    expect(log.drafts_produced).not.toContain("insight-card/feed-card");
  });
});
