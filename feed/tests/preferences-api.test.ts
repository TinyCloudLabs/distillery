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
  app = createApp({
    artifactsDir: fx.dir,
    feedbackFile: join(dir, "events.jsonl"),
    preferencesFile: prefsPath,
  });
});

afterAll(async () => {
  await fx.cleanup();
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/preferences", () => {
  test("returns the raw file text as text/plain", async () => {
    const res = await app.request("/api/preferences");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(SAMPLE);
  });

  test("missing file reads as empty text, not an error", async () => {
    const ghost = createApp({
      artifactsDir: fx.dir,
      feedbackFile: join(dir, "events.jsonl"),
      preferencesFile: join(dir, "DOES_NOT_EXIST.md"),
    });
    const res = await ghost.request("/api/preferences");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("404 when no preferences file is configured", async () => {
    const bare = createApp({
      artifactsDir: fx.dir,
      feedbackFile: join(dir, "events.jsonl"),
    });
    expect((await bare.request("/api/preferences")).status).toBe(404);
  });
});

describe("PUT /api/preferences", () => {
  test("writes the body to disk and round-trips through GET", async () => {
    const next = SAMPLE + "\n## Style\n\n- No listicles.\n";
    const res = await app.request("/api/preferences", { method: "PUT", body: next });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; bytes: number };
    expect(body.ok).toBe(true);
    expect(body.bytes).toBe(new TextEncoder().encode(next).byteLength);

    expect(await readFile(prefsPath, "utf8")).toBe(next);
    expect(await (await app.request("/api/preferences")).text()).toBe(next);
  });

  test("rejects bodies over 10KB without touching the file", async () => {
    const before = await readFile(prefsPath, "utf8");
    const res = await app.request("/api/preferences", {
      method: "PUT",
      body: "x".repeat(10 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(await readFile(prefsPath, "utf8")).toBe(before);
  });

  test("accepts a body of exactly 10KB", async () => {
    const exact = "y".repeat(10 * 1024);
    const res = await app.request("/api/preferences", { method: "PUT", body: exact });
    expect(res.status).toBe(200);
    expect(await readFile(prefsPath, "utf8")).toBe(exact);
    // restore for any later tests
    await app.request("/api/preferences", { method: "PUT", body: SAMPLE });
  });

  test("size cap counts UTF-8 bytes, not characters", async () => {
    // 4 bytes per char: 2561 chars × 4 = 10244 bytes > cap, though < 10240 chars
    const wide = "\u{1F300}".repeat(2561);
    const res = await app.request("/api/preferences", { method: "PUT", body: wide });
    expect(res.status).toBe(413);
  });

  test("404 when no preferences file is configured", async () => {
    const bare = createApp({
      artifactsDir: fx.dir,
      feedbackFile: join(dir, "events.jsonl"),
    });
    const res = await bare.request("/api/preferences", { method: "PUT", body: "hi" });
    expect(res.status).toBe(404);
  });
});
