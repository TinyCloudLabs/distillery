// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Video Generation Smoke
// smithers-description: Directly prove FAL/Seedance video generation without Claude or transcript editorial gates.
// smithers-tags: video, make-clip, fal, smoke
/** @jsxImportSource smithers-orchestrator */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dir, "..", "..");

const inputSchema = z.object({
  duration: z.enum(["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "auto"]).default("4"),
  resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
  aspect: z.enum(["1:1", "9:16", "16:9"]).default("1:1"),
  envFile: z.string().default(process.env.DEV_DISTILLERY_ENV ?? "~/development.nosync/distillery/.env"),
});

const smokeSchema = z.object({
  ok: z.boolean(),
  reportPath: z.string(),
  out: z.string().optional(),
  bytes: z.number().optional(),
  contentType: z.string().optional(),
  requestId: z.string().optional(),
  error: z.string().optional(),
  command: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  smoke: smokeSchema,
});

function tail(text: string, max = 2000): string {
  return text.length > max ? `...${text.slice(-max)}` : text;
}

export default smithers((ctx) => (
  <Workflow name="video-generation-smoke">
    <Task id="smoke" output={outputs.smoke} timeoutMs={30 * 60_000} heartbeatTimeoutMs={25 * 60_000} maxAttempts={1}>
      {async () => {
        const reportsDir = resolve(repoRoot, ".smithers", "reports");
        await mkdir(reportsDir, { recursive: true });
        const outDir = resolve(reportsDir, `video-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        const args = [
          "skills/make-clip/scripts/video-smoke.ts",
          "--out-dir",
          outDir,
          "--env-file",
          ctx.input.envFile ?? "~/development.nosync/distillery/.env",
          "--duration",
          ctx.input.duration ?? "4",
          "--resolution",
          ctx.input.resolution ?? "480p",
          "--aspect",
          ctx.input.aspect ?? "1:1",
          "--keep",
        ];
        const command = `bun ${args.join(" ")}`;
        try {
          const res = await execFileAsync("bun", args, {
            cwd: repoRoot,
            timeout: 30 * 60_000,
            maxBuffer: 8 * 1024 * 1024,
          });
          const reportPath = resolve(outDir, "video-smoke-report.json");
          const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
          return {
            ok: report.ok === true,
            reportPath,
            out: typeof report.out === "string" ? report.out : undefined,
            bytes: typeof report.bytes === "number" ? report.bytes : undefined,
            contentType: typeof report.contentType === "string" ? report.contentType : undefined,
            requestId: typeof report.requestId === "string" ? report.requestId : undefined,
            command,
          };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          const reportPath = resolve(outDir, "video-smoke-report.json");
          const message = tail(`${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`.trim());
          await writeFile(reportPath, JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
          return { ok: false, reportPath, error: message, command };
        }
      }}
    </Task>
  </Workflow>
));
