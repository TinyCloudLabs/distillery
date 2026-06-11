import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FeedbackSummary } from "../skills/_shared/lib/feedback.ts";

const SCRIPT = resolve(
  import.meta.dir,
  "../skills/distill-preferences/scripts/summarize-events.ts",
);

let dir: string;
let eventsPath: string;
let artifactsDir: string;

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "distillery-sumcli-"));
  eventsPath = join(dir, "events.jsonl");
  artifactsDir = join(dir, "artifacts");

  const events = [
    { artifact_id: "a-1", artifact_type: "insight-card", action: "more", ts: "2026-06-10T10:00:00Z" },
    { artifact_id: "a-1", artifact_type: "insight-card", action: "more", ts: "2026-06-10T11:00:00Z" },
    { artifact_id: "a-2", artifact_type: "podcast", action: "less", note: "too internal", ts: "2026-06-10T12:00:00Z" },
  ];
  await writeFile(
    eventsPath,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n" + '{"partial', // trailing partial line
    "utf8",
  );

  const a1 = join(artifactsDir, "insight-card", "one");
  await mkdir(a1, { recursive: true });
  await writeFile(
    join(a1, "artifact.json"),
    JSON.stringify({
      id: "a-1",
      type: "insight-card",
      headline: "Pricing insight",
      tags: ["pricing"],
      source_transcripts: ["/tmp/t.md"],
      generated_at: "2026-06-09T00:00:00Z",
      quality: { critic_pass: true, quotes_verified: true },
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("summarize-events CLI", () => {
  test("emits a JSON summary joined with artifacts (default format)", async () => {
    const { code, stdout } = await run([
      "--events",
      eventsPath,
      "--artifacts-dir",
      artifactsDir,
    ]);
    expect(code).toBe(0);
    const s = JSON.parse(stdout) as FeedbackSummary;
    expect(s.total_events).toBe(3); // partial line skipped
    expect(s.by_action.more).toBe(2);
    expect(s.by_action.less).toBe(1);

    const a1 = s.by_artifact.find((r) => r.artifact_id === "a-1")!;
    expect(a1.headline).toBe("Pricing insight");
    expect(a1.tags).toEqual(["pricing"]);
    expect(s.by_tag.find((r) => r.key === "pricing")!.total).toBe(2);

    const a2 = s.by_artifact.find((r) => r.artifact_id === "a-2")!;
    expect(a2.artifact_type).toBe("podcast"); // not on disk — event type survives
    expect(a2.notes[0]!.note).toBe("too internal");
  });

  test("emits markdown with --format md, including notes", async () => {
    const { code, stdout } = await run([
      "--events",
      eventsPath,
      "--artifacts-dir",
      artifactsDir,
      "--format",
      "md",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("# Feedback summary");
    expect(stdout).toContain("Total events: 3");
    expect(stdout).toContain("## By artifact");
    expect(stdout).toContain("Pricing insight");
    expect(stdout).toContain("## By tag");
    expect(stdout).toContain("| pricing |");
    expect(stdout).toContain("too internal");
  });

  test("missing events file and artifacts dir produce an empty summary, not an error", async () => {
    const { code, stdout } = await run([
      "--events",
      join(dir, "nope.jsonl"),
      "--artifacts-dir",
      join(dir, "no-artifacts"),
    ]);
    expect(code).toBe(0);
    const s = JSON.parse(stdout) as FeedbackSummary;
    expect(s.total_events).toBe(0);
    expect(s.by_artifact).toEqual([]);
  });

  test("rejects an unknown format", async () => {
    const { code, stderr } = await run(["--format", "yaml"]);
    expect(code).toBe(2);
    expect(stderr).toContain("usage:");
  });

  test("rejects unknown flags", async () => {
    const { code } = await run(["--bogus"]);
    expect(code).toBe(2);
  });
});
