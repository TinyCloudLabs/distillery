// GET/PUT /api/preferences — the preferences panel's file round-trip.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { makeFixture, type Fixture } from "./fixtures.ts";

const SAMPLE = `# PREFERENCES

## Topics

- More cross-transcript drift findings.
- [learned] Less SPARQ-internal content (3x less on sparq-tagged cards, Jun 2026)
`;

let fx: Fixture;
let dir: string;
let prefsPath: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  fx = await makeFixture();
  dir = await mkdtemp(join(tmpdir(), "distillery-prefs-test-"));
  prefsPath = join(dir, "PREFERENCES.md");
  await writeFile(prefsPath, SAMPLE);
  // auth disabled: this suite is about ETag/concurrency semantics — the gate
  // itself (401 before any ETag logic) is covered in auth.test.ts.
  app = createApp({
    artifactsDir: fx.dir,
    feedbackFile: join(dir, "events.jsonl"),
    preferencesFile: prefsPath,
    auth: { disabled: true },
  });
});

afterAll(async () => {
  await fx.cleanup();
  await rm(dir, { recursive: true, force: true });
});

/** GET the current ETag — PUTs must present it as If-Match. */
async function currentEtag(a: ReturnType<typeof createApp> = app): Promise<string> {
  const res = await a.request("/api/preferences");
  const etag = res.headers.get("etag");
  if (!etag) throw new Error("GET /api/preferences returned no ETag");
  return etag;
}

function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new TextEncoder().encode(text));
  return hasher.digest("hex");
}

describe("GET /api/preferences", () => {
  test("returns the raw file text as text/plain", async () => {
    const res = await app.request("/api/preferences");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(SAMPLE);
  });

  test("returns an ETag that is the sha256 of the body bytes", async () => {
    const res = await app.request("/api/preferences");
    expect(res.headers.get("etag")).toBe(`"${sha256Hex(await res.text())}"`);
  });

  test("missing file reads as empty text, not an error", async () => {
    const ghost = createApp({
      artifactsDir: fx.dir,
      feedbackFile: join(dir, "events.jsonl"),
      preferencesFile: join(dir, "DOES_NOT_EXIST.md"),
      auth: { disabled: true },
    });
    const res = await ghost.request("/api/preferences");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    // a missing file still has a version (hash of empty) so PUT can create it
    expect(res.headers.get("etag")).toBe(`"${sha256Hex("")}"`);
  });

  test("404 when no preferences file is configured", async () => {
    const bare = createApp({
      artifactsDir: fx.dir,
      feedbackFile: join(dir, "events.jsonl"),
      auth: { disabled: true },
    });
    expect((await bare.request("/api/preferences")).status).toBe(404);
  });
});

describe("PUT /api/preferences", () => {
  test("happy path: GET etag → PUT If-Match → write lands and round-trips", async () => {
    const next = SAMPLE + "\n## Style\n\n- No listicles.\n";
    const res = await app.request("/api/preferences", {
      method: "PUT",
      headers: { "If-Match": await currentEtag() },
      body: next,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; bytes: number; etag: string };
    expect(body.ok).toBe(true);
    expect(body.bytes).toBe(new TextEncoder().encode(next).byteLength);
    // PUT hands back the new version so the client can keep editing
    expect(body.etag).toBe(`"${sha256Hex(next)}"`);
    expect(res.headers.get("etag")).toBe(body.etag);

    expect(await readFile(prefsPath, "utf8")).toBe(next);
    const round = await app.request("/api/preferences");
    expect(await round.text()).toBe(next);
    expect(round.headers.get("etag")).toBe(body.etag);
  });

  test("stale If-Match → 409 without touching the file", async () => {
    const etag = await currentEtag();
    // someone else (the distill agent) rewrites the file after our GET
    await writeFile(prefsPath, SAMPLE + "- [learned] Agent added this meanwhile.\n");
    const onDisk = await readFile(prefsPath, "utf8");

    const res = await app.request("/api/preferences", {
      method: "PUT",
      headers: { "If-Match": etag },
      body: "human edit based on a stale snapshot",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; etag: string };
    expect(body.error).toContain("changed on disk");
    expect(body.etag).toBe(`"${sha256Hex(onDisk)}"`);
    // the concurrent write survives untouched
    expect(await readFile(prefsPath, "utf8")).toBe(onDisk);
  });

  test("missing If-Match → 428, file untouched", async () => {
    const before = await readFile(prefsPath, "utf8");
    const res = await app.request("/api/preferences", { method: "PUT", body: "no etag" });
    expect(res.status).toBe(428);
    expect(await readFile(prefsPath, "utf8")).toBe(before);
  });

  test("rejects bodies over 10KB without touching the file", async () => {
    const before = await readFile(prefsPath, "utf8");
    const res = await app.request("/api/preferences", {
      method: "PUT",
      headers: { "If-Match": await currentEtag() },
      body: "x".repeat(10 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(await readFile(prefsPath, "utf8")).toBe(before);
  });

  test("accepts a body of exactly 10KB", async () => {
    const exact = "y".repeat(10 * 1024);
    const res = await app.request("/api/preferences", {
      method: "PUT",
      headers: { "If-Match": await currentEtag() },
      body: exact,
    });
    expect(res.status).toBe(200);
    expect(await readFile(prefsPath, "utf8")).toBe(exact);
    // restore for any later tests
    await app.request("/api/preferences", {
      method: "PUT",
      headers: { "If-Match": await currentEtag() },
      body: SAMPLE,
    });
  });

  test("size cap counts UTF-8 bytes, not characters", async () => {
    // 4 bytes per char: 2561 chars × 4 = 10244 bytes > cap, though < 10240 chars
    const wide = "\u{1F300}".repeat(2561);
    const res = await app.request("/api/preferences", {
      method: "PUT",
      headers: { "If-Match": await currentEtag() },
      body: wide,
    });
    expect(res.status).toBe(413);
  });

  test("PUT against a missing file creates it (If-Match = hash of empty)", async () => {
    const ghostPath = join(dir, "NEW_PREFERENCES.md");
    const ghost = createApp({
      artifactsDir: fx.dir,
      feedbackFile: join(dir, "events.jsonl"),
      preferencesFile: ghostPath,
      auth: { disabled: true },
    });
    const res = await ghost.request("/api/preferences", {
      method: "PUT",
      headers: { "If-Match": await currentEtag(ghost) },
      body: "- Fresh start.\n",
    });
    expect(res.status).toBe(200);
    expect(await readFile(ghostPath, "utf8")).toBe("- Fresh start.\n");
  });

  test("404 when no preferences file is configured", async () => {
    const bare = createApp({
      artifactsDir: fx.dir,
      feedbackFile: join(dir, "events.jsonl"),
      auth: { disabled: true },
    });
    const res = await bare.request("/api/preferences", { method: "PUT", body: "hi" });
    expect(res.status).toBe(404);
  });
});
