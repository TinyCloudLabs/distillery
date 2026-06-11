import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "skills", "_shared", "scripts", "novelty-scan.ts");

// Synthetic fixtures only — never real meeting content.
const SCAN_ONE = `# Sync One
**Date:** 2026-03-01

## Transcript

**Ada Lovelace (00:05:00):**
The bridge round needs $100k to close before demo day.

**Grace Hopper:**
Understood, that matches what the Quartz Prototype budget assumed last week.
`;

const SCAN_TWO = `# Sync Two
**Date:** 2026-03-15

## Transcript

**Ada Lovelace:**
We still need 50 grand to close the bridge round.

**Grace Hopper:**
Noted. The Quartz Prototype demo is also due by Friday.
`;

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("novelty-scan CLI", () => {
  let dir: string;
  let onePath: string;
  let twoPath: string;
  let artifactsDir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "novelty-scan-"));
    onePath = join(dir, "one.md");
    twoPath = join(dir, "two.md");
    await writeFile(onePath, SCAN_ONE);
    await writeFile(twoPath, SCAN_TWO);
    artifactsDir = join(dir, "artifacts");
    const cardDir = join(artifactsDir, "insight-card", "old");
    await mkdir(cardDir, { recursive: true });
    await writeFile(
      join(cardDir, "artifact.json"),
      JSON.stringify({
        id: "1",
        type: "insight-card",
        headline: "Bridge round close is slipping",
        tags: ["fundraising"],
        source_transcripts: [onePath],
        generated_at: "2026-03-02T00:00:00Z",
        quality: { critic_pass: true, quotes_verified: true },
      }),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("json output: all three analyses present", () => {
    const res = runCli([onePath, twoPath, "--artifacts-dir", artifactsDir], dir);
    expect(res.exitCode).toBe(0);
    const scan = JSON.parse(res.stdout) as {
      transcriptCount: number;
      quantities: { groups: { mentions: { value: string }[] }[]; singles: unknown[] };
      singleVoice: { term: string }[];
      baseline: { entries: { headline: string }[] };
    };
    expect(scan.transcriptCount).toBe(2);
    const drift = scan.quantities.groups.find((g) =>
      g.mentions.some((m) => m.value === "$100k"),
    );
    expect(drift).toBeDefined();
    expect(drift!.mentions.map((m) => m.value)).toEqual(["$100k", "50 grand"]);
    expect(scan.singleVoice.find((t) => t.term === "quartz prototype")).toBeDefined();
    expect(scan.baseline.entries[0]!.headline).toBe("Bridge round close is slipping");
  });

  test("md output: readable report with all sections", () => {
    const res = runCli([onePath, twoPath, "--artifacts-dir", artifactsDir, "--format", "md"], dir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("# Novelty scan");
    expect(res.stdout).toContain("## Quantified claims — drift candidates");
    expect(res.stdout).toContain("**$100k**");
    expect(res.stdout).toContain("## Single-voice topics");
    expect(res.stdout).toContain("Quartz Prototype");
    expect(res.stdout).toContain("## Prior-artifact baseline");
    expect(res.stdout).toContain("Bridge round close is slipping");
  });

  test("missing artifacts dir: empty baseline, no failure", () => {
    const res = runCli(
      [onePath, "--artifacts-dir", join(dir, "nope"), "--format", "md"],
      dir,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("- (none under");
  });

  test("--out writes the file and reports counts on stderr", async () => {
    const outPath = join(dir, "scan.md");
    const res = runCli(
      [onePath, twoPath, "--artifacts-dir", artifactsDir, "--format", "md", "--out", outPath],
      dir,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Wrote md novelty scan");
    expect(await readFile(outPath, "utf8")).toContain("# Novelty scan");
  });

  test("no paths → usage, exit 2; bad flag → usage", () => {
    expect(runCli([], dir).exitCode).toBe(2);
    expect(runCli([onePath, "--bogus"], dir).exitCode).toBe(2);
    expect(runCli([onePath, "--format", "yaml"], dir).exitCode).toBe(2);
  });

  test("empty directory input → exit 1 with a clear message", async () => {
    const empty = join(dir, "empty");
    await mkdir(empty, { recursive: true });
    const res = runCli([empty], dir);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("No .md/.txt transcripts found");
  });
});
