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
import { existsSync } from "node:fs";

// The CLI on PATH (`tc`) is an OLD published @tinycloud/cli that lacks
// `kv put --space`. The skills need the local source build (`tc-local`,
// js-sdk master @ 0.7.0-beta.2). Resolve it explicitly; never silently use
// the wrong binary (that would write KV to the wrong space / fail opaquely).
const DEFAULT_TC_LOCAL =
  "/Users/samgbafa/Documents/github/tinycloud-dev/bin/tc-local";

/**
 * Resolve the tc binary in priority order:
 *   1. TC_BIN env override (the project escape hatch, mirrors FEED_TC_BIN)
 *   2. the known tc-local source build, if present
 *   3. `tc` on PATH (last resort; may be too old for `kv put --space`)
 */
export function tcBin(): string {
  const override = process.env.TC_BIN?.trim();
  if (override) return override;
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
  const res = await kvPut(key, b64, target, opts);
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
