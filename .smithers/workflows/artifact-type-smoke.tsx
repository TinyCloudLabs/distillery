// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Artifact Type Smoke
// smithers-description: Deterministically smoke-test Artifactory coverage for one artifact type or the full type matrix.
// smithers-tags: artifacts, testing, distillery, observability
/** @jsxImportSource smithers-orchestrator */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import {
  ARTIFACT_TYPES,
  FORMAT_REGISTRY,
  type ArtifactType,
} from "../../skills/_shared/lib/formats.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const execFileAsync = promisify(execFile);

const artifactInputValues = [
  "all",
  "insight-card",
  "article",
  "podcast",
  "clip",
  "digest",
  "social-post",
  "investor-update-snippet",
  "quote-card",
  "person-brief",
] as const;

const inputSchema = z.object({
  artifactType: z.enum(artifactInputValues).default("all"),
  timeoutMs: z.number().int().min(1_000).max(10 * 60_000).default(120_000),
});

const testResultSchema = z.object({
  ok: z.boolean(),
  command: z.string(),
  detail: z.string(),
});

const artifactCheckSchema = z.object({
  type: z.string(),
  ok: z.boolean(),
  label: z.string(),
  render: z.enum(["tweet", "article", "video"]),
  outward: z.boolean(),
  miner: z.string().nullable(),
  skillPath: z.string().nullable(),
  tests: z.array(testResultSchema),
  notes: z.array(z.string()),
});

const matrixSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  artifactType: z.string(),
  reportPath: z.string(),
  checks: z.array(artifactCheckSchema),
  commands: z.array(z.string()),
  notes: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  matrix: matrixSchema,
});

const typeTests: Record<ArtifactType, string[]> = {
  "insight-card": [
    "tests/artifact.test.ts",
    "tests/render-type.test.ts",
    "tests/extract-insights.test.ts",
    "tests/hot-take.test.ts",
  ],
  article: ["tests/artifact.test.ts", "tests/render-type.test.ts", "tests/write-article.test.ts"],
  podcast: [
    "tests/artifact.test.ts",
    "tests/render-type.test.ts",
    "tests/make-podcast.test.ts",
    "tests/compress.test.ts",
    "tests/narrative-seeds.test.ts",
  ],
  clip: ["tests/artifact.test.ts", "tests/render-type.test.ts", "tests/make-clip.test.ts"],
  digest: ["tests/artifact.test.ts", "tests/render-type.test.ts", "tests/write-digest.test.ts"],
  "social-post": [
    "tests/artifact.test.ts",
    "tests/render-type.test.ts",
    "tests/banger-extractor.test.ts",
    "tests/abstraction.test.ts",
    "tests/slop-scrubber.test.ts",
  ],
  "investor-update-snippet": [
    "tests/artifact.test.ts",
    "tests/render-type.test.ts",
    "tests/investor-snippet.test.ts",
  ],
  "quote-card": ["tests/artifact.test.ts", "tests/render-type.test.ts", "tests/quote-card.test.ts"],
  "person-brief": [
    "tests/artifact.test.ts",
    "tests/render-type.test.ts",
    "tests/person-brief.test.ts",
    "tests/feed-run-miners.test.ts",
  ],
};

const skillPathByType: Record<ArtifactType, string | null> = {
  "insight-card": "skills/extract-insights/SKILL.md",
  article: "skills/write-article/SKILL.md",
  podcast: "skills/make-podcast/SKILL.md",
  clip: "skills/make-clip/SKILL.md",
  digest: "skills/write-digest/SKILL.md",
  "social-post": "skills/banger-extractor/SKILL.md",
  "investor-update-snippet": "skills/investor-snippet/SKILL.md",
  "quote-card": "skills/quote-card/SKILL.md",
  "person-brief": "skills/person-brief/SKILL.md",
};

function selectedTypes(input: (typeof artifactInputValues)[number]): ArtifactType[] {
  return input === "all" ? [...ARTIFACT_TYPES] : [input];
}

function detail(stdout?: string, stderr?: string, message?: string): string {
  const text = `${stdout ?? ""}${stderr ?? ""}`.trim() || message || "";
  return text.slice(-2_000);
}

async function runTests(files: string[], timeoutMs: number): Promise<{ ok: boolean; command: string; detail: string }> {
  const args = ["test", ...files];
  const command = `bun ${args.join(" ")}`;
  try {
    const res = await execFileAsync("bun", args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, command, detail: detail(res.stdout, res.stderr) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, command, detail: detail(e.stdout, e.stderr, e.message) };
  }
}

async function writeReport(name: string, report: { reportPath: string }): Promise<string> {
  const reportsDir = resolve(repoRoot, ".smithers", "reports");
  await mkdir(reportsDir, { recursive: true });
  const file = resolve(reportsDir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  report.reportPath = file;
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", "utf8");
  return file;
}

export default smithers((ctx) => (
  <Workflow name="artifact-type-smoke">
    <Task id="matrix" output={outputs.matrix} timeoutMs={10 * 60_000}>
      {async () => {
        const target = ctx.input.artifactType ?? "all";
        const timeoutMs = ctx.input.timeoutMs ?? 120_000;
        const checks = [];
        const commands: string[] = [];
        const notes = [
          "Deterministic smoke only: no TinyCloud publish, no Claude generation, no Gemini/FAL spend.",
          "Use this before a live agent-run-staged target run to prove type registration, routing, skill docs, and unit coverage.",
        ];

        for (const type of selectedTypes(target)) {
          const meta = FORMAT_REGISTRY[type];
          const skillPath = skillPathByType[type];
          const typeNotes: string[] = [];
          let ok = true;

          if (!meta) {
            ok = false;
            typeNotes.push("missing FORMAT_REGISTRY entry");
          }
          if (skillPath && !existsSync(resolve(repoRoot, skillPath))) {
            ok = false;
            typeNotes.push(`missing ${skillPath}`);
          }
          if (type === "insight-card") {
            typeNotes.push("hot-take also saves insight-card artifacts; this smoke covers both extract-insights and hot-take.");
          }
          if (type === "person-brief") {
            typeNotes.push("person-brief is salience-triggered: registry miner is null, but the skill publishes internal briefs when audience is internal.");
          }

          const test = await runTests(typeTests[type], timeoutMs);
          commands.push(test.command);
          ok = ok && test.ok;

          checks.push({
            type,
            ok,
            label: meta.label,
            render: meta.render,
            outward: meta.outward,
            miner: meta.miner,
            skillPath,
            tests: [test],
            notes: typeNotes,
          });
        }

        const failed = checks.filter((check) => !check.ok);
        const report = {
          ok: failed.length === 0,
          summary:
            failed.length === 0
              ? `Artifact smoke passed for ${checks.length} type${checks.length === 1 ? "" : "s"}.`
              : `Artifact smoke failed for ${failed.map((check) => check.type).join(", ")}.`,
          artifactType: target,
          reportPath: "",
          checks,
          commands,
          notes,
        };
        report.reportPath = await writeReport("artifact-type-smoke", report);
        return report;
      }}
    </Task>
  </Workflow>
));
