// config.ts — resolve the agent backend's runtime paths + tunables from env,
// anchored to the distillery REPO ROOT (this file is harness/agent/src/, so the
// repo root is three levels up — same convention as harness/feed/src/server.ts).
//
// TWO SEPARATE ROOTS, both OUTSIDE the repo:
//
//   AGENT_STATE_DIR (default <home>/.tinycloud-agent) — CREDENTIALS ONLY:
//     agent-key.json   — the stable agent wallet key → did:pkh
//     delegation.json  — the last-POSTed serialized PortableDelegation
//     api-token        — the per-install API bearer token
//     tc-home/.tinycloud/... — the sandboxed tc profile (HOME for skill spawns)
//
//   AGENT_RUNS_DIR (default <home>/.tinycloud-agent-runs) — RUN SCRATCH ONLY:
//     <run_id>/status.json        — per-run state for GET /agent/run/:id
//     <run_id>/{corpus,artifacts} — per-run scratch (wiped after each run)
//
// WHY TWO ROOTS (the generate-step credential boundary): the generate `claude -p`
// step is --add-dir'd onto a run's corpus/artifacts scratch and is told to
// Read/Write there. The credentials must therefore live in a DIFFERENT tree than
// the scratch, so the generate child can be given the scratch root while a
// wholesale Read/Glob/Grep deny of AGENT_STATE_DIR has NO overlap with any
// --add-dir'd path. (If runs/ lived under AGENT_STATE_DIR, the deny would either
// block the run's own corpus — broken — or be defeated by the scratch grant.)
// Both roots stay OUTSIDE repoRoot so neither is reachable via cwd=repoRoot. See
// runner.ts buildGenerationArgs. (The documented residual: claude's Read tool +
// `bun -e` can still open arbitrary ABSOLUTE paths — true confinement is phase-2.)

import { resolve } from "node:path";
import { homedir } from "node:os";

const repoRoot = process.env.DISTILLERY_REPO_ROOT
  ? resolve(process.env.DISTILLERY_REPO_ROOT)
  : resolve(import.meta.dir, "..", "..", "..");

const agentStateDir = process.env.AGENT_STATE_DIR
  ? resolve(process.env.AGENT_STATE_DIR)
  : resolve(homedir(), ".tinycloud-agent");

// Run scratch lives in its OWN root, NOT under agentStateDir (see header). When
// AGENT_RUNS_DIR is unset, derive a sibling `<agentStateDir>-runs` — same parent,
// never nested inside the credential dir, so the deny pattern can't overlap it.
const runsDir = process.env.AGENT_RUNS_DIR
  ? resolve(process.env.AGENT_RUNS_DIR)
  : `${agentStateDir}-runs`;

export const config = {
  /** The distillery checkout the skills run from (cwd of every skill spawn). */
  repoRoot,
  /** Root of all agent runtime state (gitignored). */
  agentStateDir,
  /** The stable agent wallet key file. */
  agentKeyPath: resolve(agentStateDir, "agent-key.json"),
  /** The last-granted serialized delegation (for restart restore). */
  delegationPath: resolve(agentStateDir, "delegation.json"),
  /** The per-install API bearer token (generated + persisted if unset). */
  apiTokenPath: resolve(agentStateDir, "api-token"),
  /** Per-run scratch root (status.json + corpus/ + artifacts/) — a SEPARATE root
   *  from agentStateDir so the generate credential-deny never overlaps the
   *  --add-dir'd scratch. See the header + runner.ts. */
  runsDir,
  /** Sandbox HOME for skill spawns — tc reads <home>/.tinycloud. */
  tcHome: resolve(agentStateDir, "tc-home"),
  /** The tc profile name the delegation activates inside the sandbox. */
  profileName: process.env.AGENT_TC_PROFILE ?? "delegated",

  /** TinyCloud node the agent signs into + the delegation targets. */
  host: process.env.TINYCLOUD_HOST ?? "https://node.tinycloud.xyz",
  port: Number(process.env.AGENT_PORT ?? 4097),
  /** Loopback by default (a tunnel/front end connects via localhost). */
  hostname: process.env.AGENT_HOST_BIND ?? "127.0.0.1",
  name: process.env.AGENT_NAME ?? "Distillery Agent",
  /** The single trusted browser origin allowed by CORS (no wildcard). When
   *  unset, NO cross-origin request is reflected (same-origin / curl only). */
  allowedOrigin: process.env.AGENT_ALLOWED_ORIGIN?.trim() || null,
  /** Per-install API bearer token. If set via env it wins; otherwise the
   *  server generates one on first boot, persists it (0600), and logs it once. */
  apiToken: process.env.AGENT_API_TOKEN?.trim() || null,
  /** Cap on the serialized-delegation payload the server will deserialize. */
  maxDelegationBytes: Number(process.env.AGENT_MAX_DELEGATION_BYTES ?? 256 * 1024),
  /** The EVM chain the agent operates on; a delegation must match it. */
  chainId: Number(process.env.AGENT_CHAIN_ID ?? 1),
  /** Advertised delegation lifetime (informational, for GET /agent/info). */
  delegationExpiry: process.env.AGENT_DELEGATION_EXPIRY ?? "7d",
  /** How many Listen transcripts a run pulls. */
  transcriptCount: Number(process.env.AGENT_TRANSCRIPT_COUNT ?? 5),
  /** Generation model for the headless `claude -p` step. */
  genModel: process.env.AGENT_GEN_MODEL ?? "opus",
} as const;
