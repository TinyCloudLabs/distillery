// api-token.ts — the per-install API bearer token that gates the two
// state-changing endpoints (POST /agent/delegation, POST /agent/run). Without
// it, any browser origin could publish under (or DoS) the last active
// delegation. Generate once, persist 0600, reuse across restarts — so the front
// end can read it from the server log once and send it on every mutating call.
//
// Precedence: an explicit AGENT_API_TOKEN env wins (for ops that inject a
// secret); otherwise we generate + persist a random one on first boot.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmodFileSecure, writeFileSecure } from "./fs-secure.ts";

/**
 * Resolve the API token: env override, else the persisted file, else a freshly
 * generated one. The file is always (re-)secured to 0600 — written atomically
 * when fresh, and a pre-existing file's mode is repaired when reused.
 * Returns the token and whether it was freshly generated (for a one-time banner).
 */
export function ensureApiToken(
  path: string,
  envToken: string | null,
): { token: string; generated: boolean } {
  if (envToken) return { token: envToken, generated: false };

  if (existsSync(path)) {
    const persisted = readFileSync(path, "utf-8").trim();
    if (persisted.length > 0) {
      chmodFileSecure(path); // repair a looser pre-existing mode
      return { token: persisted, generated: false };
    }
  }

  const fresh = randomBytes(32).toString("base64url");
  writeFileSecure(path, fresh + "\n"); // atomic 0600 in a 0700 dir
  return { token: fresh, generated: true };
}

/** Constant-time compare a presented token against the expected one. */
export function tokenMatches(expected: string, presented: string | null): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(presented, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
