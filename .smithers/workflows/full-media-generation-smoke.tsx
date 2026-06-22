// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Full Media Generation Smoke
// smithers-description: Generate one video, one podcast, and one image-backed editorial artifact through the real Artifactory skills.
// smithers-tags: smithers, artifactory, video, podcast, image, publish, smoke
/** @jsxImportSource smithers-orchestrator */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dir, "..", "..");

const inputSchema = z.object({
  publish: z.boolean().default(false),
  duration: z.enum(["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "auto"]).default("4"),
  resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
  aspect: z.enum(["1:1", "9:16", "16:9"]).default("1:1"),
  envFile: z.string().default(process.env.DEV_DISTILLERY_ENV ?? "~/development.nosync/distillery/.env"),
});

const mediaSummarySchema = z.object({
  heroImages: z.number().int().nonnegative(),
  audio: z.number().int().nonnegative(),
  video: z.number().int().nonnegative(),
});

const publishedSchema = z.object({
  type: z.string(),
  slug: z.string(),
  media: z
    .object({
      heroImage: z.boolean(),
      audio: z.boolean(),
      video: z.boolean(),
    })
    .optional(),
});

const artifactSchema = z.object({
  kind: z.enum(["clip", "podcast", "article"]),
  dir: z.string(),
  jsonPath: z.string(),
  media: z.array(z.string()),
  commandNotes: z.array(z.string()),
});

const setupSchema = z.object({
  ok: z.boolean(),
  outDir: z.string(),
  runLabel: z.string(),
  envFile: z.string(),
  publish: z.boolean(),
  notes: z.array(z.string()),
});

const stageSchema = z.object({
  ok: z.boolean(),
  stage: z.enum(["clip", "podcast", "article"]),
  command: z.string(),
  reportPath: z.string(),
  outDir: z.string().optional(),
  artifact: artifactSchema.optional(),
  error: z.string().optional(),
});

const publishSchema = z.object({
  ok: z.boolean(),
  command: z.string(),
  reportPath: z.string(),
  agentRunId: z.string().optional(),
  statusFile: z.string().optional(),
  published: z.array(publishedSchema),
  held: z.array(z.object({ type: z.string(), slug: z.string(), reason: z.string() })),
  media: mediaSummarySchema,
  log: z.array(z.string()),
  error: z.string().optional(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  setup: setupSchema,
  clip: stageSchema,
  podcast: stageSchema,
  article: stageSchema,
  publishResult: publishSchema,
});

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function tail(text: string, max = 3000): string {
  return text.length > max ? `...${text.slice(-max)}` : text;
}

function wantsPublish(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function cliReportPath(outDir: string, stage: string): string {
  return resolve(outDir, `_smithers-${stage}-report.json`);
}

async function readReport(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function runCli(args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  try {
    const res = await execFileAsync("bun", args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      error: tail(`${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`.trim()),
    };
  }
}

function artifactFromReport(report: Record<string, unknown>): z.infer<typeof artifactSchema> | undefined {
  const artifacts = report.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) return undefined;
  return artifactSchema.parse(artifacts[0]);
}

async function runArtifactStage(
  stage: "clip" | "podcast" | "article",
  setup: z.infer<typeof setupSchema>,
  opts: {
    duration: string;
    resolution: string;
    aspect: string;
  },
  timeoutMs: number,
): Promise<z.infer<typeof stageSchema>> {
  const reportPath = cliReportPath(setup.outDir, stage);
  const args = [
    "scripts/full-media-smoke.ts",
    "--only",
    stage,
    "--out-dir",
    setup.outDir,
    "--run-label",
    setup.runLabel,
    "--report",
    reportPath,
    "--env-file",
    setup.envFile,
    "--duration",
    opts.duration,
    "--resolution",
    opts.resolution,
    "--aspect",
    opts.aspect,
  ];
  const command = `bun ${args.join(" ")}`;
  const res = await runCli(args, timeoutMs);
  let report: Record<string, unknown> = {};
  try {
    report = await readReport(reportPath);
  } catch {
    // The command output below carries the actionable failure.
  }
  const artifact = artifactFromReport(report);
  return {
    ok: res.ok && report.ok === true && artifact?.kind === stage,
    stage,
    command,
    reportPath,
    outDir: typeof report.outDir === "string" ? report.outDir : setup.outDir,
    ...(artifact ? { artifact } : {}),
    ...(!res.ok || report.ok !== true
      ? { error: String(report.error ?? res.error ?? `no ${stage} artifact in report`) }
      : {}),
  };
}

async function runPublish(setup: z.infer<typeof setupSchema>): Promise<z.infer<typeof publishSchema>> {
  const reportPath = cliReportPath(setup.outDir, "publish");
  const args = [
    "scripts/full-media-smoke.ts",
    "--publish-existing",
    setup.outDir,
    "--report",
    reportPath,
  ];
  const command = `bun ${args.join(" ")}`;
  const res = await runCli(args, 15 * 60_000);
  let report: Record<string, unknown> = {};
  try {
    report = await readReport(reportPath);
  } catch {
    // The command output below carries the actionable failure.
  }
  const publish = report.publish as Record<string, unknown> | undefined;
  return {
    ok: res.ok && report.ok === true && Boolean(publish?.runId),
    command,
    reportPath,
    agentRunId: typeof publish?.runId === "string" ? publish.runId : undefined,
    statusFile: typeof publish?.statusFile === "string" ? publish.statusFile : undefined,
    published: Array.isArray(publish?.published) ? publish.published.map((p) => publishedSchema.parse(p)) : [],
    held: Array.isArray(publish?.held)
      ? publish.held.map((h) => z.object({ type: z.string(), slug: z.string(), reason: z.string() }).parse(h))
      : [],
    media: mediaSummarySchema.parse(publish?.media ?? { heroImages: 0, audio: 0, video: 0 }),
    log: Array.isArray(publish?.log) ? publish.log.map(String) : [],
    ...(!res.ok || report.ok !== true ? { error: String(report.error ?? res.error ?? "publish failed") } : {}),
  };
}

export default smithers((ctx) => {
  const setup = ctx.outputMaybe("setup", { nodeId: "setup" });
  const clip = ctx.outputMaybe("clip", { nodeId: "clip" });
  const podcast = ctx.outputMaybe("podcast", { nodeId: "podcast" });
  const article = ctx.outputMaybe("article", { nodeId: "article" });
  const shouldPublish = wantsPublish(ctx.input.publish) && clip?.ok === true && podcast?.ok === true && article?.ok === true;

  return (
    <Workflow name="full-media-generation-smoke">
      <Sequence>
        <Task id="setup" output={outputs.setup}>
          {async () => {
            const runLabel = timestampSlug();
            const outDir = resolve(repoRoot, ".smithers", "reports", `full-media-smoke-${runLabel}`);
            return {
              ok: true,
              outDir,
              runLabel,
              envFile: ctx.input.envFile ?? "~/development.nosync/distillery/.env",
              publish: wantsPublish(ctx.input.publish),
              notes: [
                "This workflow is staged for observability: video, podcast, article image, and publish are separate Smithers nodes.",
                "The generation tasks call the real Artifactory skill scripts directly; no Claude editorial selection is involved.",
              ],
            };
          }}
        </Task>

        {setup ? (
          <Task
            id="clip"
            output={outputs.clip}
            timeoutMs={45 * 60_000}
            heartbeatTimeoutMs={35 * 60_000}
            maxAttempts={1}
          >
            {async () =>
              runArtifactStage(
                "clip",
                setup,
                {
                  duration: ctx.input.duration ?? "4",
                  resolution: ctx.input.resolution ?? "480p",
                  aspect: ctx.input.aspect ?? "1:1",
                },
                45 * 60_000,
              )
            }
          </Task>
        ) : null}

        {clip?.ok === true && setup ? (
          <Task id="podcast" output={outputs.podcast} timeoutMs={12 * 60_000} heartbeatTimeoutMs={10 * 60_000} maxAttempts={1}>
            {async () =>
              runArtifactStage(
                "podcast",
                setup,
                {
                  duration: ctx.input.duration ?? "4",
                  resolution: ctx.input.resolution ?? "480p",
                  aspect: ctx.input.aspect ?? "1:1",
                },
                12 * 60_000,
              )
            }
          </Task>
        ) : null}

        {podcast?.ok === true && setup ? (
          <Task id="article" output={outputs.article} timeoutMs={12 * 60_000} heartbeatTimeoutMs={10 * 60_000} maxAttempts={1}>
            {async () =>
              runArtifactStage(
                "article",
                setup,
                {
                  duration: ctx.input.duration ?? "4",
                  resolution: ctx.input.resolution ?? "480p",
                  aspect: ctx.input.aspect ?? "1:1",
                },
                12 * 60_000,
              )
            }
          </Task>
        ) : null}

        {setup && shouldPublish ? (
          <Task id="publish" output={outputs.publishResult} timeoutMs={15 * 60_000} heartbeatTimeoutMs={10 * 60_000} maxAttempts={1}>
            {async () => runPublish(setup)}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
