// agent-key.ts — the stable agent wallet key behind the distillery agent's
// did:pkh. Generate once, persist (0600), reuse across restarts — so the agent
// advertises ONE stable did:pkh per deployment (the user delegates to it).
//
// Adapted from Listen's packages/agent-runtime/docker/agent-key.ts (slimmed:
// no legacy-path migration — this is a fresh local deployment).

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmodFileSecure, writeJsonSecure } from "./fs-secure.ts";

export interface AgentKeyFile {
  privateKey: string;
}

function generatePrivateKey(): string {
  return "0x" + randomBytes(32).toString("hex");
}

function isValidKey(value: unknown): value is AgentKeyFile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AgentKeyFile).privateKey === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test((value as AgentKeyFile).privateKey)
  );
}

/**
 * Load the agent key from `path`, or generate + persist a fresh one if absent.
 * The key file is mode 0600 (it is the agent's identity). Returns the key and
 * whether it was freshly generated (for a one-time log banner).
 */
export function ensureAgentKey(path: string): { key: AgentKeyFile; generated: boolean } {
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!isValidKey(parsed)) {
      throw new Error(`Invalid agent key file at ${path}: missing or malformed privateKey`);
    }
    chmodFileSecure(path); // repair a looser pre-existing mode
    return { key: parsed, generated: false };
  }
  const fresh: AgentKeyFile = { privateKey: generatePrivateKey() };
  writeJsonSecure(path, fresh); // atomic 0600 in a 0700 dir
  return { key: fresh, generated: true };
}
