// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Feed Dev Mode
// smithers-description: Probe the HTTPS Feed plus local Artifactory agent development setup.
// smithers-tags: dev, feed, observability
/** @jsxImportSource smithers-orchestrator */
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  feedRoot: z.string().default("../feed"),
  feedHost: z.string().default("https://feed.localhost:1355"),
  agentHost: z.string().default("https://agent.feed.localhost:1355"),
  devEnv: z.string().default("~/development.nosync/distillery/.env"),
});

const checkSchema = z.object({
  name: z.string(),
  status: z.enum(["pass", "fail", "blocked"]),
  ok: z.boolean(),
  detail: z.string(),
});

const devModeSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  checks: z.array(checkSchema),
  commands: z.array(z.string()),
  notes: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  devMode: devModeSchema,
});

const execFileAsync = promisify(execFile);

function expandHome(path: string): string {
  return path === "~" ? process.env.HOME ?? path : path.replace(/^~\//, `${process.env.HOME ?? "~"}/`);
}

function toDetail(stdout?: string, stderr?: string): string {
  return `${stdout ?? ""}${stderr ?? ""}`.trim().slice(0, 600);
}

async function runCapture(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 5_000,
    });
    return { ok: true, detail: toDetail(res.stdout, res.stderr) };
  } catch (err) {
    const record = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    const detail = toDetail(record.stdout, record.stderr) || record.message || `exit ${record.code ?? "unknown"}`;
    return { ok: false, detail: detail.slice(0, 600) };
  }
}

function classifyEndpointFailure(detail: string): "fail" | "blocked" {
  return /Operation not permitted|not permitted|EACCES|EPERM/i.test(detail) ? "blocked" : "fail";
}

function hasLocalDevListeners(listenerLines: string): boolean {
  return /:1355\b/.test(listenerLines) && /:4\d{3}\b/.test(listenerLines);
}

async function curlOk(url: string): Promise<{ status: "pass" | "fail" | "blocked"; ok: boolean; detail: string }> {
  try {
    const res = await execFileAsync("curl", ["-k", "-sS", "-m", "4", url], { timeout: 5_000 });
    const text = toDetail(res.stdout, res.stderr);
    return { status: "pass", ok: true, detail: text.slice(0, 240) };
  } catch (err) {
    const record = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    const text = toDetail(record.stdout, record.stderr) || record.message || `exit ${record.code ?? "unknown"}`;
    const status = classifyEndpointFailure(text);
    const prefix =
      status === "blocked"
        ? "local network probe blocked by sandbox/permissions; rerun outside sandbox or approve local curl: "
        : "";
    return { status, ok: false, detail: `${prefix}${text}`.slice(0, 600) };
  }
}

export default smithers((ctx) => (
  <Workflow name="feed-dev-mode">
    <Task id="probe" output={outputs.devMode} retries={0}>
      {async () => {
        const cwd = process.cwd();
        const feedRootInput = typeof ctx.input.feedRoot === "string" ? ctx.input.feedRoot : "../feed";
        const feedHost = typeof ctx.input.feedHost === "string" ? ctx.input.feedHost : "https://feed.localhost:1355";
        const agentHost =
          typeof ctx.input.agentHost === "string" ? ctx.input.agentHost : "https://agent.feed.localhost:1355";
        const devEnvInput =
          typeof ctx.input.devEnv === "string" ? ctx.input.devEnv : "~/development.nosync/distillery/.env";
        const feedRoot = resolve(cwd, feedRootInput);
        const devEnv = expandHome(devEnvInput);
        const checks: z.infer<typeof checkSchema>[] = [];

        const add = (name: string, status: "pass" | "fail" | "blocked", detail: string) =>
          checks.push({ name, status, ok: status === "pass", detail });
        const addBool = (name: string, ok: boolean, detail: string) => add(name, ok ? "pass" : "fail", detail);
        addBool("feed repo", existsSync(resolve(feedRoot, "package.json")), feedRoot);
        addBool(
          "feed portless script",
          existsSync(resolve(feedRoot, "node_modules/.bin/portless")),
          "run `bun install` in ../feed if missing",
        );
        addBool(
          "agent launcher",
          existsSync(resolve(cwd, "scripts/artifact-agent-dev-https.sh")),
          "scripts/artifact-agent-dev-https.sh",
        );
        addBool("local Gemini env", existsSync(devEnv), `${devEnv} (${existsSync(devEnv) ? "present" : "missing"})`);

        const listeners = await runCapture("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
        const listenerLines = listeners.detail
          .split("\n")
          .filter((line) => /:(1355|4\d{3})\b/.test(line))
          .join("\n");
        const listenerStatus =
          listeners.ok && listenerLines.length > 0 ? "pass" : classifyEndpointFailure(listeners.detail);
        add(
          "local listeners",
          listenerStatus,
          listenerLines || listeners.detail || "(no matching listeners)",
        );
        const localListenersPresent = hasLocalDevListeners(listenerLines);

        const portlessBin = resolve(feedRoot, "node_modules/.bin/portless");
        const portless = existsSync(portlessBin)
          ? await runCapture(portlessBin, ["list"], { cwd: feedRoot })
          : await runCapture("bunx", ["portless", "list"], { cwd: feedRoot });
        const routeDetail = portless.detail || "(no portless output)";
        const hasFeedRoute = routeDetail.includes("feed.localhost");
        const hasAgentRoute = routeDetail.includes("agent.feed.localhost");
        const noActiveRoutes = /No active routes/i.test(routeDetail);
        const routeStatus =
          portless.ok && hasFeedRoute && hasAgentRoute
            ? "pass"
            : noActiveRoutes && localListenersPresent
              ? "blocked"
              : "fail";
        add(
          "portless routes",
          routeStatus,
          routeStatus === "blocked"
            ? `${routeDetail}\nLocal listeners are present, so route inspection may be blocked by sandbox PID/process visibility. Verify with unsandboxed \`portless list\`.`
            : routeDetail,
        );

        const agent = await curlOk(`${agentHost}/agent/info`);
        add(
          "agent HTTPS endpoint",
          agent.status === "fail" && localListenersPresent ? "blocked" : agent.status,
          agent.status === "fail" && localListenersPresent
            ? `${agent.detail}\nLocal listeners are present; this may be sandbox-localhost isolation rather than an agent outage.`
            : agent.detail,
        );
        const feed = await curlOk(feedHost);
        add(
          "feed HTTPS endpoint",
          feed.status === "fail" && localListenersPresent ? "blocked" : feed.status,
          feed.status === "fail" && localListenersPresent
            ? `${feed.detail}\nLocal listeners are present; this may be sandbox-localhost isolation rather than a Feed outage.`
            : feed.detail,
        );

        const ok = checks.every((check) => check.status === "pass");
        const blocked = checks.some((check) => check.status === "blocked");
        return {
          ok,
          summary: ok
            ? "Feed HTTPS dev mode is reachable and the local agent endpoint responds."
            : blocked
              ? "Feed HTTPS dev mode could not be fully verified because local network probes were blocked by the current sandbox."
              : "Feed HTTPS dev mode is not fully ready; inspect failed checks before running generation.",
          checks,
          commands: [
            "cd ../feed && bun run dev",
            "AGENT_API_TOKEN=local-claude-dev PORTLESS_PORT=1355 bun run artifact:agent:dev:https",
            "bunx smithers-orchestrator workflow run feed-dev-mode",
          ],
          notes: [
            "Feed reads VITE_AGENT_CONFIG_OVERRIDE=1, VITE_AGENT_HOST, and VITE_AGENT_TOKEN from ../feed/.env.local.",
            "The agent launcher sources DEV_DISTILLERY_ENV or ~/development.nosync/distillery/.env for GEMINI_API_KEY without copying secrets into this repo.",
            "If local listeners are present but Portless routes or endpoint fetches are blocked/failing, the probe may be running inside a restricted sandbox; rerun it outside the sandbox before treating Portless as broken.",
            "Long-term, move Gemini and other API keys into TinyCloud Secret Manager instead of local env files.",
          ],
        };
      }}
    </Task>
  </Workflow>
));
