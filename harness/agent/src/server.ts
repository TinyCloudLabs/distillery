// server.ts — the distillery agent backend (MVP, runs locally; Phala is phase 2).
// Holds a stable agent key (→ did:pkh), accepts a user's delegation, and runs
// the artifact pipeline UNDER that delegation, publishing to the USER's space.
//
// THE CONTRACT (.context/FRONTEND-AGENT-PLAN.md — the front end depends on it):
//   GET  /agent/info            → { did, name, permissions[], challenge? }
//   POST /agent/delegation      { serialized } → { ok, agentDid, delegationCid, spaceId, expiresAt }
//   POST /agent/run             {} → { run_id, status:"queued" }
//   GET  /agent/run/:run_id     → { run_id, status, published?[], error? }
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
import { createRun, isValidRunId, readRun, writeRun } from "./runs.ts";
import { PERMISSIONS } from "./permissions.ts";
import { ensureApiToken, tokenMatches } from "./api-token.ts";

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
  if (config.allowedOrigin && origin && origin === config.allowedOrigin) {
    base["Access-Control-Allow-Origin"] = config.allowedOrigin;
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

// Serialize runs: the pipeline writes to a per-run scratch dir but shares the
// one delegated tc profile, so one run at a time keeps the session coherent.
let runningRunId: string | null = null;

async function handleInfo(req: Request): Promise<Response> {
  return json(req, 200, {
    did: session.agentDid,
    name: config.name,
    permissions: PERMISSIONS,
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
  if (runningRunId) {
    return json(req, 409, {
      error: { code: "run_in_progress", message: `A run is already in progress (${runningRunId}).` },
    });
  }

  const state = createRun();
  runningRunId = state.run_id;

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
    if (runningRunId === state.run_id) runningRunId = null;
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
  // The API contract response (drop internal fields: startedAt/log/etc.).
  return json(req, 200, {
    run_id: state.run_id,
    status: state.status,
    published: state.published,
    ...(state.error ? { error: state.error } : {}),
  });
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
  `[agent] CORS origin ${config.allowedOrigin ?? "(none — set AGENT_ALLOWED_ORIGIN for a browser front end)"}`,
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
