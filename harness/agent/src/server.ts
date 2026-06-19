// server.ts — the distillery agent backend (MVP, runs locally; Phala is phase 2).
// Holds a stable agent key (→ did:pkh), accepts a user's delegation, and runs
// the artifact pipeline UNDER that delegation, publishing to the USER's space.
//
// THE CONTRACT (.context/FRONTEND-AGENT-PLAN.md — the front end depends on it):
//   GET  /agent/info            → { did, name, permissions[], challenge? }
//   POST /agent/delegation      { serialized } → { ok, agentDid, delegationCid, spaceId, expiresAt }
//   POST /agent/run             {} → { run_id, status:"queued" }
//   GET  /agent/run/:run_id     → { run_id, status, published?[], error? }
//   GET  /agent/runs            → { runs: RunSummary[], lock? }  (recent runs + shared lock)
//
// Run from the distillery repo root:  bun harness/agent/src/server.ts
//   AGENT_PORT (4097) AGENT_HOST_BIND (127.0.0.1) TINYCLOUD_HOST AGENT_STATE_DIR
//   AGENT_TC_PROFILE (delegated) AGENT_NAME AGENT_GEN_MODEL (opus)
//   NODE_SDK_DIST (override the built @tinycloud/node-sdk path)
// The spawned pipeline INHERITS this server's env (Gemini key, claude on PATH)
// but with HOME pinned to the sandbox — see runner.ts.

import { config } from "./config.ts";
import { AgentSession, type ActiveDelegation } from "./session.ts";
import { runPipeline, type RunState } from "./runner.ts";
import {
  acquireRunLock,
  createRun,
  createRunId,
  getRunLockSummary,
  isValidRunId,
  listRuns,
  readRun,
  releaseRunLock,
  summarizePublishedMedia,
  writeRun,
} from "./runs.ts";
import { PERMISSIONS } from "./permissions.ts";
import { ensureApiToken, tokenMatches } from "./api-token.ts";

const RUN_LOG_TAIL = 20;

// ── AUTH + CORS ───────────────────────────────────────────────────────────
// This is a credential-holding service: POST /agent/delegation and POST
// /agent/run mutate state / publish under the active delegation, so they REQUIRE
// the per-install bearer token. The operator reads the token from the persisted
// file (`cat <AGENT_STATE_DIR>/api-token`) or sets AGENT_API_TOKEN; the front end
// then sends it on every mutating call as:
//     Authorization: Bearer <token>      (or:  x-agent-token: <token>)
// The token is NEVER printed to the log (a secret in stdout leaks to anything
// that captures the process output). GET /agent/info stays public (DID + perms).
//
// CORS is locked to a single trusted origin (AGENT_ALLOWED_ORIGIN) — NEVER the
// `*` wildcard, which would let any web page drive this agent. When the env is
// unset, no cross-origin request is reflected (curl / same-origin only).
const { token: apiToken, generated: tokenGenerated } = ensureApiToken(
  config.apiTokenPath,
  config.apiToken,
);

/** The CORS headers for an allowed request: reflect the origin only if it matches. */
function corsHeaders(req: Request): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-agent-token",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  const origin = req.headers.get("origin");
  if (origin && config.allowedOrigins.includes(origin)) {
    base["Access-Control-Allow-Origin"] = origin;
  }
  return base;
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

/** Pull the presented bearer token from Authorization: Bearer or x-agent-token. */
function presentedToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1]!.trim();
  }
  const xToken = req.headers.get("x-agent-token");
  return xToken ? xToken.trim() : null;
}

/** True when the request carries the valid per-install token. */
function isAuthorized(req: Request): boolean {
  return tokenMatches(apiToken, presentedToken(req));
}

const session = await AgentSession.bootstrap();

function providerEnabled(...names: string[]): boolean {
  return names.some((name) => Boolean(process.env[name]?.trim()));
}

async function handleInfo(req: Request): Promise<Response> {
  const imageEnabled = providerEnabled("GOOGLE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY");
  const videoProviderConfigured = providerEnabled("FAL_KEY");
  const videoFlagEnabled = process.env.AGENT_ENABLE_VIDEO === "1";
  return json(req, 200, {
    did: session.agentDid,
    name: config.name,
    permissions: PERMISSIONS,
    generation: {
      transcriptCount: config.transcriptCount,
      targetArtifacts: config.targetArtifacts,
      model: config.genModel,
      mediaFocus: config.mediaFocus,
      media: {
        images: {
          enabled: imageEnabled,
          reason: imageEnabled ? "image provider configured" : "image provider not configured",
        },
        video: {
          enabled: videoProviderConfigured && videoFlagEnabled,
          reason: videoProviderConfigured
            ? videoFlagEnabled
              ? "video provider configured and enabled"
              : "video provider configured, but AGENT_ENABLE_VIDEO is not enabled"
            : "video provider not configured",
        },
      },
    },
    // No challenge in the MVP — the front end delegates straight to did:pkh.
  });
}

async function handlePostDelegation(req: Request): Promise<Response> {
  let body: { serialized?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(req, 400, { error: { code: "invalid_json", message: "Body must be JSON." } });
  }
  const serialized = body?.serialized;
  if (typeof serialized !== "string" || serialized.length === 0) {
    return json(req, 400, {
      error: { code: "invalid_body", message: "Body must be { serialized: string } (non-empty)." },
    });
  }

  try {
    const active = await session.activate(serialized);
    console.log(`[agent] activated delegation cid=${active.delegationCid} space=${active.spaceId}`);
    return json(req, 200, {
      ok: true,
      agentDid: session.agentDid,
      delegationCid: active.delegationCid,
      spaceId: active.spaceId,
      expiresAt: active.expiresAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent] activation failed:`, err);
    // A malformed/expired/over-broad delegation is the client's fault (400); a
    // node failure mid-activation is ours (500). The validator + deserializer
    // throw messages prefixed "invalid delegation" / mention chainId|JSON|
    // deserialize|expired|escalation — treat those as 400, everything else 500.
    const clientFault = /chainId|JSON|deserialize|invalid|expired|escalation|exceeds|audience/i.test(
      message,
    );
    return json(req, clientFault ? 400 : 500, {
      error: { code: clientFault ? "invalid_delegation" : "activation_failed", message },
    });
  }
}

async function handlePostRun(req: Request): Promise<Response> {
  const active = session.getActive();
  if (!active) {
    return json(req, 409, {
      error: { code: "no_delegation", message: "No delegation granted yet. POST /agent/delegation first." },
    });
  }
  const runId = createRunId();
  const lock = acquireRunLock(runId, "agent-http");
  if (!lock.ok) {
    return json(req, 409, {
      error: { code: "run_in_progress", message: lock.message, run_id: lock.activeRunId },
    });
  }

  let state: RunState;
  try {
    state = createRun(runId);
  } catch (err) {
    releaseRunLock(runId);
    const message = err instanceof Error ? err.message : String(err);
    return json(req, 500, { error: { code: "run_create_failed", message } });
  }

  // Fire-and-forget: the run executes in the background; the client polls
  // GET /agent/run/:id. Errors are captured into the run's status.json.
  void executeRun(state, active);

  return json(req, 202, { run_id: state.run_id, status: "queued" });
}

async function executeRun(state: RunState, active: ActiveDelegation): Promise<void> {
  try {
    await runPipeline(active, state, writeRun);
  } catch (err) {
    state.status = "error";
    state.error = err instanceof Error ? err.message : String(err);
    state.finishedAt = Date.now();
    state.log.push(`${new Date().toISOString()} ERROR: ${state.error}`);
    writeRun(state);
    console.error(`[agent] run ${state.run_id} failed:`, err);
  } finally {
    releaseRunLock(state.run_id);
  }
}

function handleGetRun(req: Request, runId: string): Response {
  if (!isValidRunId(runId)) {
    return json(req, 400, { error: { code: "invalid_run_id", message: "Malformed run_id." } });
  }
  const state = readRun(runId);
  if (!state) {
    return json(req, 404, { error: { code: "not_found", message: `Unknown run ${runId}.` } });
  }
  const log = Array.isArray(state.log) ? state.log.slice(-RUN_LOG_TAIL) : [];
  return json(req, 200, {
    run_id: state.run_id,
    status: state.status,
    published: state.published,
    media: summarizePublishedMedia(state.published),
    startedAt: state.startedAt,
    ...(typeof state.finishedAt === "number" ? { finishedAt: state.finishedAt } : {}),
    ...(log.length > 0 ? { log } : {}),
    ...(state.error ? { error: state.error } : {}),
  });
}

/** List recent runs (light summaries) so a client can detect an in-progress
 *  build. Public — same as GET /agent/info and GET /agent/run/:id. */
function handleListRuns(req: Request): Response {
  const lock = getRunLockSummary();
  return json(req, 200, { runs: listRuns(), ...(lock ? { lock } : {}) });
}

/** 401 for a mutating request that lacks the valid per-install token. */
function unauthorized(req: Request): Response {
  return json(req, 401, {
    error: {
      code: "unauthorized",
      message: "Missing or invalid agent token (Authorization: Bearer <token> or x-agent-token).",
    },
  });
}

Bun.serve({
  port: config.port,
  hostname: config.hostname,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    if (url.pathname === "/agent/info" && req.method === "GET") {
      return handleInfo(req); // public
    }
    if (url.pathname === "/agent/runs" && req.method === "GET") {
      return handleListRuns(req); // public
    }
    if (url.pathname === "/agent/delegation" && req.method === "POST") {
      if (!isAuthorized(req)) return unauthorized(req);
      return handlePostDelegation(req);
    }
    if (url.pathname === "/agent/run" && req.method === "POST") {
      if (!isAuthorized(req)) return unauthorized(req);
      return handlePostRun(req);
    }
    const runMatch = url.pathname.match(/^\/agent\/run\/([^/]+)$/);
    if (runMatch && req.method === "GET") {
      return handleGetRun(req, decodeURIComponent(runMatch[1]!));
    }
    return json(req, 404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
  },
});

console.log(`[agent] listening on ${config.hostname}:${config.port}`);
console.log(`[agent] repo root   ${config.repoRoot}`);
console.log(`[agent] tc sandbox  ${config.tcHome}/.tinycloud (profile: ${config.profileName})`);
console.log(`[agent] state dir   ${config.agentStateDir}`);
console.log(
  `[agent] CORS origin ${
    config.allowedOrigins.length > 0
      ? config.allowedOrigins.join(", ")
      : "(none — set AGENT_ALLOWED_ORIGIN for a browser front end)"
  }`,
);
// NEVER print the token itself (a secret in stdout leaks). Point the operator at
// the persisted file instead; the front end gets the token from there.
if (tokenGenerated) {
  console.log("");
  console.log("==================================================================");
  console.log(`  Generated a per-install API token (required on POST`);
  console.log(`  /agent/delegation and POST /agent/run). Read it with:`);
  console.log(`    cat ${config.apiTokenPath}`);
  console.log(`  (file mode 0600). Or set AGENT_API_TOKEN to pin your own.`);
  console.log(`  Send it as: Authorization: Bearer <token>  (or x-agent-token).`);
  console.log("==================================================================");
  console.log("");
} else {
  console.log(`[agent] API token   loaded (required on POST /agent/{delegation,run})`);
}
