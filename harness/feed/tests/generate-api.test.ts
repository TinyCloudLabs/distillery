// generate-api.test.ts — the gated Generate button (spec §8).
//
// Covers the contract: unauth POST → 401 (rides the /api/* gate); authed POST →
// 202 + { run_id }; a second concurrent run → 409 (lockfile, R1); the status
// endpoint shape; the dry_run path. The spawn is INJECTED (a fake) so no real
// feed-run / claude ever runs — the test asserts the HTTP surface + the
// run-dir/lockfile bookkeeping deterministically.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import type { GenerateConfig, SpawnFn, ChildHandle } from "../src/generate.ts";
import {
  acquireLock,
  isValidRunId,
  releaseLock,
  safeRunDir,
} from "../src/generate.ts";
import { SESSION_COOKIE_NAME } from "../src/session.ts";
import { makeFixture, type Fixture } from "./fixtures.ts";

const ALLOWED = "0x6Ac0836fF53107F990233688A95CF44f58bBbFD6";

let fx: Fixture;
let stateDir: string;
let repoRoot: string;
let runsDir: string;
let lockPath: string;
let sessionsDbPath: string;

/** A fake spawn that records the call and never starts a real process. */
function recordingSpawn(calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[]): SpawnFn {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    const handle: ChildHandle = {
      pid: 4242,
      unref() {},
      on() {},
    };
    return handle;
  };
}

function makeConfig(spawn: SpawnFn): GenerateConfig {
  return { repoRoot, runsDir, lockPath, spawn, env: { BASE: "1" } };
}

function appWith(generate: GenerateConfig, opts?: { disabled?: boolean }) {
  return createApp({
    artifactsDir: fx.dir,
    distDir: stateDir,
    feedbackFile: join(stateDir, "events.jsonl"),
    auth: opts?.disabled
      ? { disabled: true }
      : { sessionsDbPath, allowedAddresses: [ALLOWED], disabled: false },
    generate,
  });
}

async function signInCookie(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/auth/openkey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: ALLOWED, keyId: "k", keyType: "MANAGED" }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  if (!m) throw new Error("no session cookie");
  return `${SESSION_COOKIE_NAME}=${m[1]}`;
}

beforeEach(async () => {
  fx = await makeFixture();
  stateDir = await mkdtemp(join(tmpdir(), "distillery-gen-"));
  await writeFile(join(stateDir, "index.html"), "<!doctype html><title>feed</title>");
  repoRoot = await mkdtemp(join(tmpdir(), "distillery-gen-repo-"));
  runsDir = join(repoRoot, "index", "runs");
  lockPath = join(repoRoot, "index", ".run.lock");
  sessionsDbPath = join(stateDir, "sessions.db");
  await mkdir(join(repoRoot, "index"), { recursive: true });
});

afterEach(async () => {
  await fx.cleanup();
  await rm(stateDir, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

describe("POST /api/generate — auth gate", () => {
  test("unauthenticated → 401 (gated before any spawn)", async () => {
    const calls: any[] = [];
    const app = appWith(makeConfig(recordingSpawn(calls)));
    const res = await app.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(calls.length).toBe(0); // never spawned
  });
});

describe("POST /api/generate — authed", () => {
  test("→ 202 + run_id, spawns the wrapper detached, stamps a running status", async () => {
    const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    const app = appWith(makeConfig(recordingSpawn(calls)));
    const cookie = await signInCookie(app);

    const res = await app.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { run_id: string; mode: string; dry_run: boolean };
    expect(typeof body.run_id).toBe("string");
    expect(body.mode).toBe("daily");
    expect(body.dry_run).toBe(false);

    // Spawned the wrapper once, detached, with the run id threaded through.
    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).toBe("/bin/bash");
    expect(calls[0]!.args[0]).toContain("feedrun.sh");
    expect(calls[0]!.env.FEEDRUN_RUN_ID).toBe(body.run_id);
    expect(calls[0]!.env.FEEDRUN_DRY_RUN).toBe("0");
    expect(calls[0]!.env.BASE).toBe("1"); // injected base env passed through

    // A running status.json was stamped into the run dir.
    const status = await app.request(`/api/generate/${encodeURIComponent(body.run_id)}`, {
      headers: { cookie },
    });
    expect(status.status).toBe(200);
    const s = (await status.json()) as { status: string; run_id: string };
    expect(s.status).toBe("running");
    expect(s.run_id).toBe(body.run_id);
  });

  test("dry_run=true → FEEDRUN_DRY_RUN=1 and the status reports dry_run", async () => {
    const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    const app = appWith(makeConfig(recordingSpawn(calls)));
    const cookie = await signInCookie(app);

    const res = await app.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { dry_run: boolean };
    expect(body.dry_run).toBe(true);
    expect(calls[0]!.env.FEEDRUN_DRY_RUN).toBe("1");
  });

  test("invalid body → 400", async () => {
    const app = appWith(makeConfig(recordingSpawn([])));
    const cookie = await signInCookie(app);
    const res = await app.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ mode: "sideways" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/generate — concurrency (spec §10 R1)", () => {
  test("a second concurrent run → 409 while the lock is held by a live pid", async () => {
    const app = appWith(makeConfig(recordingSpawn([])));
    const cookie = await signInCookie(app);

    // Simulate the wrapper holding the lock with THIS process's (live) pid.
    await writeFile(lockPath, `${process.pid}\n2026-06-11T07:00:00Z\n`);

    const res = await app.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already in progress");
  });

  test("a STALE lock (dead pid) does not block a new run", async () => {
    const calls: any[] = [];
    const app = appWith(makeConfig(recordingSpawn(calls)));
    const cookie = await signInCookie(app);

    // A pid that is (almost certainly) not alive.
    await writeFile(lockPath, `999999\n2026-06-11T07:00:00Z\n`);

    const res = await app.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    expect(calls.length).toBe(1);
  });
});

describe("GET /api/generate/:run_id — status shape", () => {
  test("unknown run id → 404", async () => {
    const app = appWith(makeConfig(recordingSpawn([])));
    const cookie = await signInCookie(app);
    const res = await app.request("/api/generate/2099-01-01T00-00-00.000Z", {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  test("a finished run reads outcome + artifacts off the orchestrator run-log", async () => {
    const app = appWith(makeConfig(recordingSpawn([])));
    const cookie = await signInCookie(app);

    // Start a run (stamps running), then simulate the orchestrator writing its
    // run-log.json into the same dir (the completion marker).
    const start = await app.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    const { run_id } = (await start.json()) as { run_id: string };
    const runDir = join(runsDir, run_id.replace(/[:]/g, "-"));
    expect(existsSync(join(runDir, "status.json"))).toBe(true);

    await writeFile(
      join(runDir, "run-log.json"),
      JSON.stringify({
        run_id,
        mode: "daily",
        dry_run: false,
        outcome: "completed",
        artifacts_published: ["insight-card/foo", "article/bar"],
        finished_at: "2026-06-11T07:05:00Z",
      }),
    );

    const res = await app.request(`/api/generate/${encodeURIComponent(run_id)}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const s = (await res.json()) as {
      status: string;
      outcome: string;
      artifacts_published: string[];
      finished_at: string;
    };
    expect(s.status).toBe("done");
    expect(s.outcome).toBe("completed");
    expect(s.artifacts_published).toEqual(["insight-card/foo", "article/bar"]);
    expect(s.finished_at).toBe("2026-06-11T07:05:00Z");
  });

  test("status endpoint is gated → unauth 401", async () => {
    const app = appWith(makeConfig(recordingSpawn([])));
    const res = await app.request("/api/generate/whatever");
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// SECURITY: path traversal via GET /api/generate/:run_id (review High #1)
// ===========================================================================
describe("GET /api/generate/:run_id — path traversal is blocked", () => {
  // Plant a secret OUTSIDE runsDir (a sibling run-log.json the route would leak
  // if `..` resolved). The traversal target mirrors the reported exploit.
  async function plantSecret(): Promise<void> {
    await writeFile(join(repoRoot, "index", "secret"), "TOP SECRET");
    await mkdir(join(repoRoot, "index", "secretdir"), { recursive: true });
    await writeFile(
      join(repoRoot, "index", "secretdir", "run-log.json"),
      JSON.stringify({ outcome: "leaked", artifacts_published: ["SECRET"] }),
    );
  }

  test("..%2f traversal → 400, never reads outside runsDir", async () => {
    const app = appWith(makeConfig(recordingSpawn([])));
    const cookie = await signInCookie(app);
    await plantSecret();
    // The reported exploit: encoded ../../ to climb out of index/runs.
    const res = await app.request("/api/generate/..%2f..%2fsecretdir", {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("invalid run_id");
  });

  test("a single encoded ../ segment → 400", async () => {
    const app = appWith(makeConfig(recordingSpawn([])));
    const cookie = await signInCookie(app);
    const res = await app.request("/api/generate/..%2fsecretdir", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  test("an absolute path id → 400 (decoded leading slash)", async () => {
    const app = appWith(makeConfig(recordingSpawn([])));
    const cookie = await signInCookie(app);
    // %2Fetc%2Fpasswd → /etc/passwd after Hono decodes the param.
    const res = await app.request("/api/generate/%2Fetc%2Fpasswd", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  test("a backslash / null-byte / percent id → 400", async () => {
    const app = appWith(makeConfig(recordingSpawn([])));
    const cookie = await signInCookie(app);
    for (const id of ["foo%5Cbar", "foo%00bar", "foo%25bar"]) {
      const res = await app.request(`/api/generate/${id}`, { headers: { cookie } });
      expect(res.status).toBe(400);
    }
  });

  test("a VALID ISO run id is accepted (404 unknown, not 400)", async () => {
    const app = appWith(makeConfig(recordingSpawn([])));
    const cookie = await signInCookie(app);
    const res = await app.request("/api/generate/2026-06-11T14-00-00.000Z", {
      headers: { cookie },
    });
    // Valid format, no such run → 404 (NOT 400). Proves the allowlist lets real ids through.
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// SECURITY: the route's lock is ATOMIC, not check-then-write (review High #2)
// ===========================================================================
describe("POST /api/generate — the route acquires the lock atomically", () => {
  test("two concurrent POSTs → exactly one 202, the other 409 (no double spawn)", async () => {
    const calls: any[] = [];
    const app = appWith(makeConfig(recordingSpawn(calls)));
    const cookie = await signInCookie(app);

    // Fire both POSTs without awaiting the first — the race the old
    // readLock-then-spawn pre-check lost (both passed the read, both spawned).
    const [a, b] = await Promise.all([
      app.request("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({}),
      }),
      app.request("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({}),
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]); // exactly one winner
    expect(calls.length).toBe(1); // and exactly one wrapper spawn — no double spend
  });

  test("the winner stamps a live lock (the recording spawn never releases it)", async () => {
    const app = appWith(makeConfig(recordingSpawn([])));
    const cookie = await signInCookie(app);
    const res = await app.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    // The atomic lock file exists, owned by a live pid → a follow-up POST is 409.
    expect(existsSync(lockPath)).toBe(true);
    const again = await app.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(409);
  });
});

// ===========================================================================
// UNIT: the run-id allowlist + containment guard (review High #1)
// ===========================================================================
describe("isValidRunId / safeRunDir", () => {
  test("accepts the real ISO run-id formats", () => {
    expect(isValidRunId("2026-06-11T14:00:00.000Z")).toBe(true); // colon form (in-memory)
    expect(isValidRunId("2026-06-11T14-00-00.000Z")).toBe(true); // dash form (on disk)
  });

  test("rejects traversal / slash / absolute / null / percent / empty / overlong", () => {
    for (const bad of [
      "",
      "..",
      "../secret",
      "../../secret",
      "a/b",
      "a\\b",
      "/etc/passwd",
      "foo bar",
      "foo%2fbar",
      "a".repeat(65),
      "has space",
    ]) {
      expect(isValidRunId(bad)).toBe(false);
    }
  });

  test("safeRunDir contains the resolved path inside runsDir", () => {
    const runsDir = "/tmp/repo/index/runs";
    const ok = safeRunDir(runsDir, "2026-06-11T14:00:00.000Z");
    expect(ok).not.toBeNull();
    expect(ok!.startsWith("/tmp/repo/index/runs/")).toBe(true);
    // Anything that would escape (or fails the allowlist) → null, never a path.
    expect(safeRunDir(runsDir, "../../secret")).toBeNull();
    expect(safeRunDir(runsDir, "/etc/passwd")).toBeNull();
    expect(safeRunDir(runsDir, "")).toBeNull(); // the runs dir itself is not a run
  });
});

// ===========================================================================
// UNIT: atomic acquireLock — exactly one winner, stale reclaim (review High #2)
// ===========================================================================
describe("acquireLock (atomic, O_EXCL)", () => {
  test("a second acquire while the holder is alive loses (409 material)", () => {
    const lp = join(repoRoot, "index", ".unit.lock");
    const first = acquireLock(lp, process.pid); // live holder
    expect(first.ok).toBe(true);
    const second = acquireLock(lp, process.pid);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.pid).toBe(process.pid);
    releaseLock(lp);
    // After release, a fresh acquire wins again.
    expect(acquireLock(lp, process.pid).ok).toBe(true);
    releaseLock(lp);
  });

  test("a STALE lock (dead pid) is reclaimed on the next acquire", async () => {
    const lp = join(repoRoot, "index", ".unit-stale.lock");
    // Plant a lock owned by a dead pid.
    await writeFile(lp, `999999\n2026-06-11T07:00:00Z\n`);
    const res = acquireLock(lp, process.pid);
    expect(res.ok).toBe(true); // reclaimed, not blocked
    releaseLock(lp);
  });
});

describe("generation not configured", () => {
  test("POST → 501 when the server has no generate config", async () => {
    const app = createApp({
      artifactsDir: fx.dir,
      distDir: stateDir,
      feedbackFile: join(stateDir, "events.jsonl"),
      auth: { disabled: true },
      // no generate
    });
    const res = await app.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(501);
  });
});
