// tc.ts — a thin, predictable wrapper around the `tc` CLI for the TinyCloud
// integration skills (tc-listen-read, tc-publish, bootstrap). It does ONE
// thing: run a `tc` subcommand with `--json --quiet`, parse the JSON, and
// surface the real error. No graceful fallbacks — a missing capability, an
// unhosted space, or a malformed response throws loudly so the caller's
// remediation logic (§3.4 of the greenfield contract) can branch on the
// structured `error.code`, never on exit code (a server 401 is also exit 1).
//
// Why a wrapper and not the node-sdk directly: the contract's proven path is
// the CLI (tc-write-delegation-verified.md). `tc` runs js-sdk master with
// `kv put --space`, binary-safe base64 KV round-trips, `sql execute`, and the
// auth request/grant/import handshake. Keeping skills on `tc` means they
// inherit profile/default-space/session state with zero SDK wiring.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const AGENT_PACKAGE_TC = resolve(REPO_ROOT, "harness/agent/node_modules/.bin/tc");
const AGENT_PACKAGE_NODE_SDK = resolve(
  REPO_ROOT,
  "harness/agent/node_modules/@tinycloud/node-sdk/dist/index.js",
);
const DEFAULT_HOST = "https://node.tinycloud.xyz";
export const KV_PUT_ARG_VALUE_MAX_BYTES = 96 * 1024;

// The CLI on PATH (`tc`) can be an OLD published @tinycloud/cli that lacks
// delegation/space fixes the agent needs. Prefer the agent package's pinned CLI,
// then the historical local source build if present, and only then PATH.
const DEFAULT_TC_LOCAL =
  "/Users/samgbafa/Documents/github/tinycloud-dev/bin/tc-local";

/**
 * Resolve the tc binary in priority order:
 *   1. TC_BIN env override (the project escape hatch, mirrors FEED_TC_BIN)
 *   2. harness/agent's pinned @tinycloud/cli package
 *   3. the known tc-local source build, if present
 *   4. `tc` on PATH (last resort; may be too old for delegation/space support)
 */
export function tcBin(): string {
  const override = process.env.TC_BIN?.trim();
  if (override) return override;
  if (existsSync(AGENT_PACKAGE_TC)) return AGENT_PACKAGE_TC;
  if (existsSync(DEFAULT_TC_LOCAL)) return DEFAULT_TC_LOCAL;
  return "tc";
}

/** The structured error TinyCloud returns under `--json`. */
export interface TcError {
  code: string;
  message: string;
  hint?: string;
}

/** A tc invocation that returned a `{ error: ... }` JSON body. */
export class TcCliError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly argv: readonly string[];
  readonly exitCode: number;
  constructor(error: TcError, argv: readonly string[], exitCode: number) {
    super(error.message);
    this.name = "TcCliError";
    this.code = error.code;
    this.hint = error.hint;
    this.argv = argv;
    this.exitCode = exitCode;
  }
}

export interface TcRunOptions {
  /** Profile to run under (global --profile). Defaults to the active profile. */
  profile?: string;
  /** Extra env (merged over process.env). */
  env?: Record<string, string>;
}

interface RawResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function execTc(args: string[], opts: TcRunOptions): Promise<RawResult> {
  const argv = [...args];
  if (opts.profile) argv.unshift("--profile", opts.profile);
  // --json structured output; --quiet drops the banner so stdout is pure JSON.
  argv.unshift("--json", "--quiet");

  return new Promise((resolve, reject) => {
    const child = spawn(tcBin(), argv, {
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 0 }),
    );
  });
}

/**
 * Run a `tc` subcommand and return its parsed JSON result.
 *
 * Throws {@link TcCliError} when the JSON body carries an `error` object
 * (the caller branches on `.code`: AUTH_UNAUTHORIZED, SPACE_NOT_HOSTED, …).
 * Throws a plain Error when tc produced no parseable JSON at all (a crash,
 * an OpenKey browser-flow hang, or a binary-not-found) — that is never a
 * normal control-flow signal, so it must not be swallowed.
 */
export async function tcJson<T = unknown>(
  args: string[],
  opts: TcRunOptions = {},
): Promise<T> {
  const { stdout, stderr, exitCode } = await execTc(args, opts);
  // tc emits the result JSON on stdout, but routes `{ error: ... }` bodies to
  // stderr on a non-zero exit. Prefer stdout; fall back to stderr so a
  // structured error still surfaces as a TcCliError (not an opaque throw).
  const text = stdout.trim() || stderr.trim();
  if (!text) {
    throw new Error(
      `tc produced no output (exit ${exitCode}). args: ${args.join(" ")}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `tc output was not JSON (exit ${exitCode}). args: ${args.join(" ")}\n` +
        `stdout: ${stdout.trim()}\n` +
        `stderr: ${stderr.trim()}`,
    );
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    parsed.error &&
    typeof parsed.error === "object"
  ) {
    throw new TcCliError(parsed.error as TcError, args, exitCode);
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export interface SqlExecuteResult {
  changes: number;
  lastInsertRowId: number;
}

export interface SqlQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

export interface SqlTarget {
  /** --db value, e.g. "xyz.tinycloud.artifacts/feed". */
  db: string;
  /** --space name or URI. Omit to use the profile's default space. */
  space?: string;
}

function withTarget(base: string[], t: SqlTarget): string[] {
  const argv = [...base, "--db", t.db];
  if (t.space) argv.push("--space", t.space);
  return argv;
}

/** Run a write statement (CREATE/INSERT/UPDATE/DELETE) — `tc sql execute`. */
export function sqlExecute(
  statement: string,
  target: SqlTarget,
  params?: unknown[],
  opts: TcRunOptions = {},
): Promise<SqlExecuteResult> {
  const argv = withTarget(["sql", "execute", statement], target);
  if (params && params.length > 0) argv.push("--params", JSON.stringify(params));
  return tcJson<SqlExecuteResult>(argv, opts);
}

/** Run a read statement (SELECT) — `tc sql query`. */
export function sqlQuery(
  statement: string,
  target: SqlTarget,
  params?: unknown[],
  opts: TcRunOptions = {},
): Promise<SqlQueryResult> {
  const argv = withTarget(["sql", "query", statement], target);
  if (params && params.length > 0) argv.push("--params", JSON.stringify(params));
  return tcJson<SqlQueryResult>(argv, opts);
}

// ---------------------------------------------------------------------------
// KV (binary via base64 string — `kv put --file` round-trips as a Buffer JSON
// and is BROKEN; base64 string round-trips byte-identical. Verified.)
// ---------------------------------------------------------------------------

export interface KvTarget {
  /** --space name or URI. Omit to use the profile's default space. */
  space?: string;
}

interface StoredProfile {
  name?: string;
  host?: string;
  privateKey?: string;
  authMethod?: string;
  defaultSpace?: string;
  did?: string;
  sessionDid?: string;
  ownerDid?: string;
  address?: string;
  chainId?: number;
}

interface StoredSession {
  delegationHeader?: { Authorization: string };
  delegationCid?: string;
  spaceId?: string;
  jwk?: object;
  verificationMethod?: string;
  address?: string;
  chainId?: number;
  siwe?: unknown;
  signature?: unknown;
}

interface StoredTcContext {
  home: string;
  profileName: string;
  host: string;
  profile: StoredProfile;
  session: StoredSession | null;
}

type TinyCloudNodeSdk = {
  TinyCloudNode: new (options: { host: string }) => {
    restoreSession(sessionData: Record<string, unknown>): Promise<void>;
    kv: {
      put(key: string, value: string): Promise<{ ok: boolean; error?: unknown }>;
    };
    kvForSpace(spaceId: string): {
      put(key: string, value: string): Promise<{ ok: boolean; error?: unknown }>;
    };
  };
};

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function envFor(opts: TcRunOptions): NodeJS.ProcessEnv {
  return { ...process.env, ...opts.env };
}

function tcConfigDir(home: string): string {
  return resolve(home, ".tinycloud");
}

function profileDir(home: string, name: string): string {
  return resolve(tcConfigDir(home), "profiles", name);
}

function canonicalizeAddress(address: string): string {
  const trimmed = address.trim();
  return trimmed.startsWith("0x")
    ? `0x${trimmed.slice(2).toLowerCase()}`
    : trimmed.toLowerCase();
}

function parsePkhDid(did: string | undefined): { chainId: number; address: string } | null {
  if (!did) return null;
  const match = did.match(/^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/);
  if (!match) return null;
  return { chainId: Number(match[1]), address: canonicalizeAddress(match[2]!) };
}

function makePkhSpaceId(address: string, chainId: number, name: string): string {
  return `tinycloud:pkh:eip155:${chainId}:${canonicalizeAddress(address)}:${name}`;
}

function parseSpaceUri(input: string): { owner: string; name: string } | null {
  if (!input.startsWith("tinycloud:")) return null;
  const parts = input.split(":");
  if (parts.length < 3) return null;
  const name = parts.at(-1);
  if (!name) return null;
  return { owner: parts.slice(1, -1).join(":"), name };
}

function resolveAddress(profile: StoredProfile, session: StoredSession | null): string {
  if (typeof session?.address === "string" && session.address.length > 0) {
    return canonicalizeAddress(session.address);
  }
  if (typeof profile.address === "string" && profile.address.length > 0) {
    return canonicalizeAddress(profile.address);
  }
  const fromOwnerDid = parsePkhDid(profile.ownerDid);
  if (fromOwnerDid) return fromOwnerDid.address;
  throw new Error(`Cannot determine Ethereum address for profile "${profile.name ?? "default"}".`);
}

function resolveChainId(profile: StoredProfile, session: StoredSession | null): number {
  if (typeof session?.chainId === "number" && Number.isFinite(session.chainId)) {
    return session.chainId;
  }
  if (typeof profile.chainId === "number" && Number.isFinite(profile.chainId)) {
    return profile.chainId;
  }
  const fromOwnerDid = parsePkhDid(profile.ownerDid);
  if (fromOwnerDid) return fromOwnerDid.chainId;
  throw new Error(`Cannot determine chain id for profile "${profile.name ?? "default"}".`);
}

export function resolveTcProfileContext(opts: TcRunOptions = {}): StoredTcContext {
  const env = envFor(opts);
  const home = env.HOME || homedir();
  const config = readJsonFile<{ defaultProfile?: string }>(
    resolve(tcConfigDir(home), "config.json"),
  );
  const profileName = opts.profile ?? env.TC_PROFILE ?? config?.defaultProfile ?? "default";
  const dir = profileDir(home, profileName);
  const profile = readJsonFile<StoredProfile>(resolve(dir, "profile.json"));
  if (!profile) {
    throw new Error(`TinyCloud profile "${profileName}" not found under ${tcConfigDir(home)}.`);
  }
  const session = readJsonFile<StoredSession>(resolve(dir, "session.json"));
  return {
    home,
    profileName,
    host: env.TC_HOST ?? profile.host ?? DEFAULT_HOST,
    profile: { ...profile, name: profile.name ?? profileName },
    session,
  };
}

export function resolveTcSpaceUri(
  input: string | undefined,
  ctx: Pick<StoredTcContext, "profile" | "session" | "profileName">,
): string | undefined {
  const effective = input || ctx.profile.defaultSpace;
  if (!effective) return undefined;
  if (effective.startsWith("tinycloud:")) {
    const parsed = parseSpaceUri(effective);
    if (!parsed) {
      throw new Error(`Invalid TinyCloud space URI "${effective}".`);
    }
    return `tinycloud:${parsed.owner}:${parsed.name}`;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(effective)) {
    throw new Error(`Invalid TinyCloud space "${effective}".`);
  }
  const address = resolveAddress(ctx.profile, ctx.session);
  const chainId = resolveChainId(ctx.profile, ctx.session);
  return makePkhSpaceId(address, chainId, effective);
}

export function shouldUseSdkKvPut(value: string): boolean {
  return Buffer.byteLength(value, "utf8") > KV_PUT_ARG_VALUE_MAX_BYTES;
}

async function loadNodeSdk(): Promise<TinyCloudNodeSdk> {
  const override = process.env.NODE_SDK_DIST?.trim();
  const path = override || AGENT_PACKAGE_NODE_SDK;
  if (!existsSync(path)) {
    throw new Error(
      `@tinycloud/node-sdk dist not found at ${path}. Run 'bun install' in harness/agent ` +
        `or set NODE_SDK_DIST to a built dist/index.js.`,
    );
  }
  return (await import(pathToFileURL(path).href)) as TinyCloudNodeSdk;
}

function sdkErrorToTc(error: unknown, argv: readonly string[]): TcCliError {
  const candidate = error as { code?: unknown; message?: unknown; hint?: unknown };
  return new TcCliError(
    {
      code: typeof candidate?.code === "string" ? candidate.code : "KV_WRITE_FAILED",
      message:
        typeof candidate?.message === "string"
          ? candidate.message
          : `TinyCloud KV put failed: ${String(error)}`,
      hint: typeof candidate?.hint === "string" ? candidate.hint : undefined,
    },
    argv,
    1,
  );
}

async function kvPutStringViaSdk(
  key: string,
  value: string,
  target: KvTarget = {},
  opts: TcRunOptions = {},
): Promise<{ key: string; written: boolean }> {
  const ctx = resolveTcProfileContext(opts);
  if (!ctx.session?.delegationHeader || !ctx.session.delegationCid || !ctx.session.spaceId) {
    throw new Error(`TinyCloud profile "${ctx.profileName}" has no restorable delegated session.`);
  }
  const sdk = await loadNodeSdk();
  const node = new sdk.TinyCloudNode({ host: ctx.host });
  await node.restoreSession({
    delegationHeader: ctx.session.delegationHeader,
    delegationCid: ctx.session.delegationCid,
    spaceId: ctx.session.spaceId,
    jwk: ctx.session.jwk,
    verificationMethod: ctx.session.verificationMethod ?? ctx.profile.did,
    address: ctx.session.address,
    chainId: ctx.session.chainId,
    siwe: ctx.session.siwe,
    signature: ctx.session.signature,
  });

  const spaceUri = resolveTcSpaceUri(target.space, ctx);
  const kv = spaceUri ? node.kvForSpace(spaceUri) : node.kv;
  const result = await kv.put(key, value);
  if (!result.ok) {
    throw sdkErrorToTc(
      result.error,
      ["kv", "put", key, "<sdk-string>", ...(target.space ? ["--space", target.space] : [])],
    );
  }
  return { key, written: true };
}

/** Put a raw string value at `key` (JSON-parsed by tc, falling back to string). */
export function kvPut(
  key: string,
  value: string,
  target: KvTarget = {},
  opts: TcRunOptions = {},
): Promise<{ key: string; written: boolean }> {
  const argv = ["kv", "put", key, value];
  if (target.space) argv.push("--space", target.space);
  return tcJson(argv, opts);
}

/**
 * Put binary bytes at `<key>.b64` (the `.b64` suffix is load-bearing — it
 * tells every reader to base64-decode). Returns the actual key written.
 */
export async function kvPutBytes(
  baseKey: string,
  bytes: Uint8Array,
  target: KvTarget = {},
  opts: TcRunOptions = {},
): Promise<{ key: string; written: boolean }> {
  const key = baseKey.endsWith(".b64") ? baseKey : `${baseKey}.b64`;
  const b64 = Buffer.from(bytes).toString("base64");
  // Keep small writes on the CLI path. For generated images/audio/video the
  // base64 payload can exceed posix_spawn's argv limit; `tc kv put --stdin` and
  // `--file` currently pass Buffers, not strings, so use the SDK restored from
  // the same delegated tc profile to preserve the `.b64` string contract.
  const res = shouldUseSdkKvPut(b64)
    ? await kvPutStringViaSdk(key, b64, target, opts)
    : await kvPut(key, b64, target, opts);
  return { key, written: res.written };
}

export interface KvListResult {
  keys: string[];
  count: number;
  prefix: string;
}

export function kvList(
  prefix: string,
  target: KvTarget = {},
  opts: TcRunOptions = {},
): Promise<KvListResult> {
  const argv = ["kv", "list", "--prefix", prefix];
  if (target.space) argv.push("--space", target.space);
  return tcJson<KvListResult>(argv, opts);
}
