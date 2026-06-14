// fs-secure.ts — credential-grade filesystem helpers. The agent's delegated
// session (session.json), the synthesized profile key (key.json), the persisted
// delegation, and the API token are all bearer secrets: under a common umask
// (022) a default-mode write is world-readable (0644), and any other local user
// could read the live delegation and act as the delegator. These helpers create
// dirs 0700 and write files 0600 atomically (tmp + rename, both private), and
// repair the mode of any pre-existing file/dir.

import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** mkdir -p with mode 0700, repairing the mode of any existing leaf dir. */
export function mkdirSecure(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // recursive mkdir honors `mode` only for dirs it creates; fix a pre-existing
  // leaf that a prior loose-umask run (or another tool) may have left open.
  try {
    if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  } catch {
    // best effort — a stat/chmod race shouldn't crash a write
  }
}

/**
 * Write raw `contents` to `path` atomically with mode 0600. The parent dir is
 * ensured 0700. The temp file is created 0600 from the start (never a 0644
 * window), and rename is atomic within the same dir.
 */
export function writeFileSecure(path: string, contents: string): void {
  mkdirSecure(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  // writeFileSync's `mode` only applies on create; if a stale tmp existed it
  // keeps its old mode — force 0600 before the rename to be safe.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Write `body` (JSON-serialized, pretty) to `path` atomically with mode 0600. */
export function writeJsonSecure(path: string, body: unknown): void {
  writeFileSecure(path, JSON.stringify(body, null, 2) + "\n");
}

/** chmod an existing file to 0600 if it is looser. No-op when absent. */
export function chmodFileSecure(path: string): void {
  if (!existsSync(path)) return;
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  } catch {
    // best effort
  }
}
