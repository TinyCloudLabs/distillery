// The serve entrypoint binds loopback-only by default — PUT /api/preferences
// is an unauthenticated write surface, so it must not face the LAN unless
// HOST is set explicitly. These tests spawn the real entrypoint (PORT=0 for
// an ephemeral port) and read the bound address back from its startup line.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const feedRoot = resolve(import.meta.dir, "..");

/** Spawn src/server.ts, return its logged listen URL, then kill it. */
async function spawnServer(env: Record<string, string>): Promise<URL> {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: feedRoot,
    env: { ...process.env, PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    let out = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      const m = /distillery feed\s+(http:\/\/\S+)/.exec(out);
      if (m) return new URL(m[1]!);
    }
    throw new Error(`server exited without a listen line; stdout: ${out}`);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

describe("server entrypoint bind address", () => {
  test("defaults to 127.0.0.1 (loopback only)", async () => {
    const url = await spawnServer({});
    expect(url.hostname).toBe("127.0.0.1");
  });

  test("HOST env overrides the bind address for tunnel/LAN use", async () => {
    const url = await spawnServer({ HOST: "0.0.0.0" });
    expect(url.hostname).toBe("0.0.0.0");
  });
});
