// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Feed Loop Readiness
// smithers-description: Deterministically report whether the Artifactory/Feed loop is ready for a live delegated run.
// smithers-tags: feed, artifactory, readiness, observability, backpressure
/** @jsxImportSource smithers-orchestrator */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const repoRoot = resolve(import.meta.dir, "..", "..");
const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(10 * 60_000).default(240_000),
  feedRoot: z.string().default("../feed"),
  agentStateDir: z.string().default("~/.tinycloud-agent"),
  agentRunsDir: z.string().default("~/.tinycloud-agent-runs"),
  devEnv: z.string().default(process.env.DEV_DISTILLERY_ENV ?? "~/development.nosync/distillery/.env"),
});

const checkStatusSchema = z.enum(["pass", "fail", "warn", "blocked"]);

const checkSchema = z.object({
  name: z.string(),
  status: checkStatusSchema,
  ok: z.boolean(),
  detail: z.string(),
  command: z.string().optional(),
});

const readinessSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  reportPath: z.string(),
  checks: z.array(checkSchema),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  commands: z.array(z.string()),
  notes: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  readiness: readinessSchema,
});

type CheckStatus = z.infer<typeof checkStatusSchema>;
type Check = z.infer<typeof checkSchema>;

function expandHome(path: string): string {
  return path === "~" ? process.env.HOME ?? path : path.replace(/^~\//, `${process.env.HOME ?? "~"}/`);
}

function resolveInputPath(path: string): string {
  const expanded = expandHome(path);
  return expanded.startsWith("/") ? expanded : resolve(repoRoot, expanded);
}

function detail(stdout?: string, stderr?: string, message?: string): string {
  return (`${stdout ?? ""}${stderr ?? ""}`.trim() || message || "").slice(-3_000);
}

async function runCheck(
  name: string,
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; required?: boolean } ,
): Promise<Check> {
  const rendered = [command, ...args].join(" ");
  try {
    const res = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });
    return {
      name,
      status: "pass",
      ok: true,
      command: rendered,
      detail: detail(res.stdout, res.stderr) || "passed",
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      name,
      status: options.required === false ? "warn" : "fail",
      ok: false,
      command: rendered,
      detail: detail(e.stdout, e.stderr, e.message),
    };
  }
}

async function gitShort(repo: string, ref = "HEAD"): Promise<string | null> {
  try {
    const res = await execFileAsync("git", ["-C", repo, "rev-parse", "--short", ref], {
      timeout: 5_000,
    });
    return res.stdout.trim();
  } catch {
    return null;
  }
}

async function gitStatus(repo: string): Promise<string | null> {
  try {
    const res = await execFileAsync("git", ["-C", repo, "status", "--short"], {
      timeout: 5_000,
    });
    return res.stdout.trim();
  } catch {
    return null;
  }
}

async function submoduleCheck(feedRoot: string): Promise<Check> {
  const embedded = resolve(repoRoot, "submodules/feed");
  if (!existsSync(resolve(feedRoot, "package.json"))) {
    return {
      name: "sibling Feed checkout",
      status: "warn",
      ok: false,
      detail: `${feedRoot} is missing; Artifactory can still use submodules/feed, but cross-repo drift cannot be checked.`,
    };
  }
  const embeddedHead = await gitShort(embedded);
  const siblingHead = await gitShort(feedRoot);
  if (!embeddedHead || !siblingHead) {
    return {
      name: "Feed submodule alignment",
      status: "blocked",
      ok: false,
      detail: `could not read git refs (embedded=${embeddedHead ?? "unknown"}, sibling=${siblingHead ?? "unknown"})`,
    };
  }
  if (embeddedHead !== siblingHead) {
    return {
      name: "Feed submodule alignment",
      status: "fail",
      ok: false,
      detail: `submodules/feed=${embeddedHead}; sibling Feed=${siblingHead}. Push Feed and update the Artifactory submodule pointer before a live run.`,
    };
  }
  return {
    name: "Feed submodule alignment",
    status: "pass",
    ok: true,
    detail: `embedded and sibling Feed are both at ${embeddedHead}`,
  };
}

async function pushedCheck(repo: string, label: string): Promise<Check> {
  const head = await gitShort(repo);
  const origin = await gitShort(repo, "refs/remotes/origin/main");
  const status = await gitStatus(repo);
  if (!head || !origin || status === null) {
    return {
      name: `${label} pushed state`,
      status: "blocked",
      ok: false,
      detail: `could not read git state (HEAD=${head ?? "unknown"}, origin=${origin ?? "unknown"})`,
    };
  }
  if (status) {
    return {
      name: `${label} pushed state`,
      status: "fail",
      ok: false,
      detail: `working tree has local changes:\n${status}`,
    };
  }
  if (head !== origin) {
    return {
      name: `${label} pushed state`,
      status: "fail",
      ok: false,
      detail: `HEAD=${head}, origin/main=${origin}`,
    };
  }
  return {
    name: `${label} pushed state`,
    status: "pass",
    ok: true,
    detail: `${label} is clean and pushed at ${head}`,
  };
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]!] = value;
  }
  return env;
}

function present(env: Record<string, string>, ...keys: string[]): boolean {
  return keys.some((key) => Boolean(process.env[key]?.trim() || env[key]?.trim()));
}

function livePrereqChecks(agentStateDir: string, agentRunsDir: string, devEnvPath: string): Check[] {
  const env = readEnvFile(devEnvPath);
  const delegationPath = resolve(agentStateDir, "delegation.json");
  const lockPath = resolve(agentRunsDir, "agent-run.lock");
  const gemini = present(env, "GOOGLE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY");
  const fal = present(env, "FAL_KEY");
  const videoEnabled = (process.env.AGENT_ENABLE_VIDEO ?? env.AGENT_ENABLE_VIDEO) === "1";
  const videoProvider = gemini || fal;
  const videoProviders = [gemini ? "Gemini/Veo preferred video" : "", fal ? "FAL/Seedance make-clip" : ""].filter(Boolean);
  const checks: Check[] = [];

  checks.push({
    name: "active TinyCloud delegation",
    status: existsSync(delegationPath) ? "pass" : "blocked",
    ok: existsSync(delegationPath),
    detail: existsSync(delegationPath)
      ? `${delegationPath} exists`
      : `${delegationPath} is missing; connect/re-grant from Feed /agents before running agent-run-staged.`,
  });

  checks.push({
    name: "agent run lock",
    status: existsSync(lockPath) ? "blocked" : "pass",
    ok: !existsSync(lockPath),
    detail: existsSync(lockPath)
      ? `${lockPath} exists; inspect /agent/runs or bun run smithers:ps before launching another run.`
      : `${lockPath} is clear`,
  });

  checks.push({
    name: "Gemini image/audio provider",
    status: gemini ? "pass" : "warn",
    ok: gemini,
    detail: gemini
      ? "Gemini provider is configured for hero images and podcast audio."
      : "No Gemini provider found in process env or dev env; live run can publish text artifacts but cannot prove generated images/podcast audio.",
  });

  checks.push({
    name: "clip video provider",
    status: videoProvider && videoEnabled ? "pass" : "warn",
    ok: videoProvider && videoEnabled,
    detail:
      videoProvider && videoEnabled
        ? `${videoProviders.join(" + ")} and AGENT_ENABLE_VIDEO=1 are present for clip generation.`
        : videoProvider
          ? `${videoProviders.join(" + ")} present, but AGENT_ENABLE_VIDEO=1 is not set; video spend is intentionally disabled.`
          : "No Gemini/Veo or FAL video provider found; live run cannot prove generated clips.",
  });

  return checks;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

async function smithersStaleRunCheck(timeoutMs: number): Promise<Check> {
  const command = "bunx smithers-orchestrator ps --all --json";
  try {
    const res = await execFileAsync("bunx", ["smithers-orchestrator", "ps", "--all", "--json"], {
      cwd: repoRoot,
      timeout: Math.min(timeoutMs, 30_000),
      maxBuffer: 3 * 1024 * 1024,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return {
        name: "Smithers stale runs",
        status: "warn",
        ok: false,
        command,
        detail: `could not parse Smithers run table JSON: ${detail(res.stdout, res.stderr)}`,
      };
    }

    const rawRuns = Array.isArray((parsed as { runs?: unknown }).runs)
      ? (parsed as { runs: unknown[] }).runs
      : Array.isArray(parsed)
        ? parsed
        : [];
    const staleRuns = rawRuns
      .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
      .filter((row) => {
        const status = stringField(row, "status").toLowerCase();
        const state = stringField(row, "state").toLowerCase();
        const dbStatus = stringField(row, "dbStatus").toLowerCase();
        const unhealthy = row.unhealthy && typeof row.unhealthy === "object" ? (row.unhealthy as Record<string, unknown>) : {};
        const unhealthyKind =
          typeof unhealthy.kind === "string" ? unhealthy.kind.toLowerCase() : "";
        return status === "stale" || state === "stale" || unhealthyKind.includes("stale") || (dbStatus === "running" && state === "stale");
      });

    if (staleRuns.length === 0) {
      return {
        name: "Smithers stale runs",
        status: "pass",
        ok: true,
        command,
        detail: `no stale Smithers runs among ${rawRuns.length} recorded run${rawRuns.length === 1 ? "" : "s"}`,
      };
    }

    const summaries = staleRuns.slice(0, 3).map((row) => {
      const unhealthy = row.unhealthy && typeof row.unhealthy === "object" ? (row.unhealthy as Record<string, unknown>) : {};
      const id = stringField(row, "id") || stringField(row, "runId") || "unknown";
      const workflow = stringField(row, "workflow") || "unknown workflow";
      const step = stringField(row, "step") || "unknown step";
      const status = stringField(row, "status") || "unknown";
      const dbStatus = stringField(row, "dbStatus") || "unknown";
      const kind = typeof unhealthy.kind === "string" ? unhealthy.kind : "stale";
      const lastHeartbeat = typeof unhealthy.lastHeartbeatAt === "string" ? `, lastHeartbeat=${unhealthy.lastHeartbeatAt}` : "";
      return `${id} (${workflow}, step=${step}, status=${status}, dbStatus=${dbStatus}, ${kind}${lastHeartbeat})`;
    });
    const firstId = stringField(staleRuns[0]!, "id") || stringField(staleRuns[0]!, "runId") || "<run-id>";
    return {
      name: "Smithers stale runs",
      status: "blocked",
      ok: false,
      command,
      detail: `${staleRuns.length} stale Smithers run${staleRuns.length === 1 ? "" : "s"} need triage before more live work: ${summaries.join("; ")}. Inspect with \`bun run smithers:why -- ${firstId}\` and \`bunx smithers-orchestrator inspect ${firstId}\`; cancel only after inspection with \`bun run smithers:cancel -- ${firstId}\`.`,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      name: "Smithers stale runs",
      status: "warn",
      ok: false,
      command,
      detail: `could not read Smithers run table: ${detail(e.stdout, e.stderr, e.message)}`,
    };
  }
}

async function writeReport(report: { reportPath: string }): Promise<string> {
  const reportsDir = resolve(repoRoot, ".smithers", "reports");
  await mkdir(reportsDir, { recursive: true });
  const file = resolve(reportsDir, `feed-loop-readiness-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  report.reportPath = file;
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", "utf8");
  return file;
}

function blocking(check: Check): boolean {
  return check.status === "fail" || check.status === "blocked";
}

export default smithers((ctx) => (
  <Workflow name="feed-loop-readiness">
    <Task id="readiness" output={outputs.readiness} timeoutMs={15 * 60_000}>
      {async () => {
        const timeoutMs = ctx.input.timeoutMs ?? 240_000;
        const feedRoot = resolveInputPath(typeof ctx.input.feedRoot === "string" ? ctx.input.feedRoot : "../feed");
        const agentStateDir = resolveInputPath(ctx.input.agentStateDir ?? "~/.tinycloud-agent");
        const agentRunsDir = resolveInputPath(ctx.input.agentRunsDir ?? "~/.tinycloud-agent-runs");
        const devEnv = resolveInputPath(ctx.input.devEnv ?? process.env.DEV_DISTILLERY_ENV ?? "~/development.nosync/distillery/.env");
        const checks: Check[] = [];
        const commands: string[] = [];

        checks.push(await pushedCheck(feedRoot, "Feed"));
        checks.push(await pushedCheck(repoRoot, "Artifactory"));
        checks.push(await submoduleCheck(feedRoot));

        for (const check of livePrereqChecks(agentStateDir, agentRunsDir, devEnv)) {
          checks.push(check);
        }
        const staleRunCheck = await smithersStaleRunCheck(timeoutMs);
        checks.push(staleRunCheck);
        if (staleRunCheck.command) commands.push(staleRunCheck.command);

        const commandChecks = [
          await runCheck("agent runner tests", "bun", ["test", "tests/agent-runner.test.ts"], {
            cwd: repoRoot,
            timeoutMs,
          }),
          await runCheck("embedded Feed frontend check", "bun", ["run", "artifact:frontend:check"], {
            cwd: repoRoot,
            timeoutMs,
          }),
          await runCheck("Smithers workflow graph check", "bun", ["run", "typecheck"], {
            cwd: resolve(repoRoot, ".smithers"),
            timeoutMs,
          }),
        ];
        for (const check of commandChecks) {
          checks.push(check);
          if (check.command) commands.push(check.command);
        }

        const blockers = checks.filter(blocking).map((check) => `${check.name}: ${check.detail}`);
        const warnings = checks.filter((check) => check.status === "warn").map((check) => `${check.name}: ${check.detail}`);
        const report = {
          ok: blockers.length === 0,
          summary:
            blockers.length === 0
              ? warnings.length === 0
                ? "Feed loop readiness passed: deterministic gates are green and live-run prerequisites are present."
                : `Feed loop readiness passed with ${warnings.length} warning(s): live run is possible, but media coverage may be partial.`
              : `Feed loop readiness blocked by ${blockers.length} check(s).`,
          reportPath: "",
          checks,
          blockers,
          warnings,
          commands,
          notes: [
            "This workflow does not start Claude, Gemini, FAL, TinyCloud writes, or a live agent run.",
            "It is the preflight gate before `agent-run-staged` when you want to prove the full delegated loop.",
            "Warnings identify partial media coverage; blockers identify conditions that should be fixed before a live run.",
            "A stale Smithers run is treated as operator backpressure: inspect before cancelling, then rerun readiness.",
          ],
        };
        report.reportPath = await writeReport(report);
        return report;
      }}
    </Task>
  </Workflow>
));
