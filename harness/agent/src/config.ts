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
//
// assertSafeLayout() enforces this at boot (fail-fast): a pathological override
// that re-nests the roots or puts them inside the repo throws a config error
// rather than silently running with an unsafe layout.

import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { mkdirSecure } from "./fs-secure.ts";

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

// True when `child` is `parent` or sits inside it (both must be absolute). The
// trailing-sep guard stops `/a/b-runs` from counting as inside `/a/b`.
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const base = parent.endsWith("/") ? parent : parent + "/";
  return child.startsWith(base);
}

/**
 * Canonicalize an absolute path so the nesting checks can't be fooled by a
 * symlink or case-insensitive FS (e.g. AGENT_RUNS_DIR=/tmp/link where /tmp/link →
 * $AGENT_STATE_DIR/runs would pass a purely lexical startsWith). The dirs may not
 * exist yet at first boot and realpathSync throws on a missing path, so we
 * realpath the nearest EXISTING ancestor and re-append the not-yet-created tail.
 */
function canonicalize(absPath: string): string {
  let tail = "";
  let cur = absPath;
  // Walk up to an existing ancestor (terminates: dirname("/") === "/").
  for (;;) {
    try {
      return tail ? resolve(realpathSync(cur), tail) : realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return absPath; // reached "/" without an existing ancestor
      // basename() is root-aware — a manual slice mis-joins when parent === "/"
      // (dirname has no trailing sep), dropping a char of the segment.
      const seg = basename(cur);
      tail = tail ? `${seg}/${tail}` : seg;
      cur = parent;
    }
  }
}

/**
 * Fail FAST at boot on an unsafe path layout. A pathological override (e.g.
 * AGENT_RUNS_DIR=$AGENT_STATE_DIR/runs, an in-repo / relative path, or a SYMLINK
 * into either) would re-nest the scratch under the credential dir — bringing back
 * the deny/--add-dir overlap — or put credentials inside the repo (reachable via
 * cwd=repoRoot). We refuse to run with such a layout rather than silently expose
 * credentials. Paths are CANONICALIZED (realpath) first so symlinks / case-only
 * differences can't slip a nested layout past the lexical checks.
 */
function assertSafeLayout(stateIn: string, runsIn: string, repoIn: string): void {
  // Both roots must be ABSOLUTE (resolve() guarantees this for our inputs; assert
  // anyway so a future code change can't regress it).
  for (const [name, p] of [["AGENT_STATE_DIR", stateIn], ["AGENT_RUNS_DIR", runsIn]] as const) {
    if (!p.startsWith("/")) {
      throw new Error(`agent config: ${name} must resolve to an absolute path (got '${p}').`);
    }
  }
  const state = canonicalize(stateIn);
  const runs = canonicalize(runsIn);
  const repo = canonicalize(repoIn);

  // (a) neither root may be nested under the other — keeps the credential deny
  //     from overlapping the --add-dir'd scratch.
  if (isWithin(runs, state) || isWithin(state, runs)) {
    throw new Error(
      `agent config: AGENT_RUNS_DIR ('${runsIn}' → '${runs}') and AGENT_STATE_DIR ('${stateIn}' → ` +
        `'${state}') must not be nested in one another — the run scratch is --add-dir'd to the ` +
        `generate step and the state dir is deny-listed; nesting reintroduces the overlap. ` +
        `Point them at separate dirs.`,
    );
  }
  // (b) both must be OUTSIDE repoRoot — inside the repo they'd be reachable via
  //     cwd=repoRoot (and could be --add-dir'd as part of the repo).
  for (const [name, raw, p] of [
    ["AGENT_STATE_DIR", stateIn, state],
    ["AGENT_RUNS_DIR", runsIn, runs],
  ] as const) {
    if (isWithin(p, repo)) {
      throw new Error(
        `agent config: ${name} ('${raw}' → '${p}') must be OUTSIDE the repo ('${repo}') — inside ` +
          `it the generate step (cwd=repoRoot) could read it. Use a path outside the checkout.`,
      );
    }
  }
}

assertSafeLayout(agentStateDir, runsDir, repoRoot);

// Create BOTH roots 0700 at startup (mkdirSecure also repairs a pre-existing
// looser mode). The run scratch root is the load-bearing one: a lazy
// mkdirSync(recursive) elsewhere would create it 0755 under the default umask,
// leaving another local user able to traverse in and read the user's RAW Listen
// transcripts/artifacts mid-run. A 0700 parent blocks that for all children.
mkdirSecure(agentStateDir);
mkdirSecure(runsDir);

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
  /** The trusted browser origins allowed by CORS (no wildcard) — a comma-
   *  separated AGENT_ALLOWED_ORIGIN parsed into an exact-match set (each entry
   *  trimmed, blanks dropped). When unset/empty, NO cross-origin request is
   *  reflected (same-origin / curl only). */
  allowedOrigins: (process.env.AGENT_ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0),
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
