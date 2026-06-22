// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Feed Composition Smoke
// smithers-description: Deterministically smoke-test freshness, ordering, diversity, cap, and dedup gates for Feed composition.
// smithers-tags: feed, composition, backpressure, testing
/** @jsxImportSource smithers-orchestrator */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const repoRoot = resolve(import.meta.dir, "..", "..");
const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(10 * 60_000).default(180_000),
});

const gateSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  command: z.string(),
  detail: z.string(),
});

const compositionSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  reportPath: z.string(),
  gates: z.array(gateSchema),
  notes: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  composition: compositionSchema,
});

const gates = [
  {
    name: "selection ordering and backpressure",
    files: ["tests/preference-signal.test.ts", "tests/selection-backpressure-proof.test.ts"],
  },
  {
    name: "format diversity and exploration reserve",
    files: ["tests/exploration-slot.test.ts", "tests/feed-run.test.ts"],
  },
  {
    name: "artifact mix planning and video reserve",
    files: ["tests/agent-runner.test.ts"],
  },
  {
    name: "published cap, draft isolation, and same-signal dedup",
    files: ["tests/feed-run-miners.test.ts", "tests/run-generation.test.ts"],
  },
] as const;

function detail(stdout?: string, stderr?: string, message?: string): string {
  const text = `${stdout ?? ""}${stderr ?? ""}`.trim() || message || "";
  return text.slice(-2_500);
}

async function runGate(
  name: string,
  files: readonly string[],
  timeoutMs: number,
): Promise<{ name: string; ok: boolean; command: string; detail: string }> {
  const args = ["test", ...files];
  const command = `bun ${args.join(" ")}`;
  try {
    const res = await execFileAsync("bun", args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 3 * 1024 * 1024,
    });
    return { name, ok: true, command, detail: detail(res.stdout, res.stderr) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { name, ok: false, command, detail: detail(e.stdout, e.stderr, e.message) };
  }
}

async function writeReport(report: { reportPath: string }): Promise<string> {
  const reportsDir = resolve(repoRoot, ".smithers", "reports");
  await mkdir(reportsDir, { recursive: true });
  const file = resolve(reportsDir, `feed-composition-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  report.reportPath = file;
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", "utf8");
  return file;
}

export default smithers((ctx) => (
  <Workflow name="feed-composition-smoke">
    <Task id="composition" output={outputs.composition} timeoutMs={10 * 60_000}>
      {async () => {
        const timeoutMs = ctx.input.timeoutMs ?? 180_000;
        const results = [];
        for (const gate of gates) {
          results.push(await runGate(gate.name, gate.files, timeoutMs));
        }
        const failed = results.filter((result) => !result.ok);
        const report = {
          ok: failed.length === 0,
          summary:
            failed.length === 0
              ? "Feed composition smoke passed: selection, diversity, cap, and dedup gates are green."
              : `Feed composition smoke failed: ${failed.map((result) => result.name).join(", ")}.`,
          reportPath: "",
          gates: results,
          notes: [
            "This is the high-level feed-quality gate above individual artifact skills.",
            "It does not generate or publish artifacts; it proves the deterministic composition rails that keep a run fresh and non-monocultural.",
            "Live quality still needs visual/browser review of generated rows, but this catches ordering/backpressure/cap regressions before spending on generation.",
          ],
        };
        report.reportPath = await writeReport(report);
        return report;
      }}
    </Task>
  </Workflow>
));
