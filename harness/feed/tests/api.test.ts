import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import type { CardsResponse, FeedCard } from "../src/types.ts";
import { makeFixture, type Fixture } from "./fixtures.ts";

let fx: Fixture;
let distDir: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  fx = await makeFixture();
  distDir = await mkdtemp(join(tmpdir(), "distillery-feed-dist-"));
  await writeFile(join(distDir, "index.html"), "<!doctype html><title>feed</title>");
  app = createApp({
    artifactsDir: fx.dir,
    distDir,
    feedbackFile: join(distDir, "events.jsonl"),
    auth: { disabled: true }, // auth surface is covered in auth.test.ts
  });
});

afterAll(async () => {
  await fx.cleanup();
  await rm(distDir, { recursive: true, force: true });
});

describe("GET /api/cards", () => {
  test("returns all cards newest first with pagination metadata", async () => {
    const res = await app.request("/api/cards");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CardsResponse;
    // 5 PUBLISHED cards: 3 internal (pod-1, ins-1, unk-1, art-1) + 1 approved
    // outward (approved-snippet-1). The pending outward draft is excluded.
    expect(body.total).toBe(5);
    expect(body.offset).toBe(0);
    expect(body.hasMore).toBe(false);
    expect(body.cards.map((c) => c.id)).toEqual([
      "pod-1",
      "ins-1",
      "approved-snippet-1",
      "unk-1",
      "art-1",
    ]);
    // The pending outward draft never appears in the published feed.
    expect(body.cards.map((c) => c.id)).not.toContain("draft-pending-1");
  });

  test("paginates with limit and offset", async () => {
    const p1 = (await (await app.request("/api/cards?limit=2&offset=0")).json()) as CardsResponse;
    expect(p1.cards.map((c) => c.id)).toEqual(["pod-1", "ins-1"]);
    expect(p1.hasMore).toBe(true);

    const p2 = (await (await app.request("/api/cards?limit=2&offset=2")).json()) as CardsResponse;
    expect(p2.cards.map((c) => c.id)).toEqual(["approved-snippet-1", "unk-1"]);
    expect(p2.hasMore).toBe(true);
  });

  test("clamps bad limit/offset values instead of erroring", async () => {
    const res = await app.request("/api/cards?limit=banana&offset=-5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CardsResponse;
    expect(body.offset).toBe(0);
    expect(body.cards.length).toBe(5);
  });
});

describe("GET /api/cards/:type/:slug", () => {
  test("returns a single card", async () => {
    const res = await app.request("/api/cards/podcast/newest-podcast");
    expect(res.status).toBe(200);
    const card = (await res.json()) as FeedCard;
    expect(card.id).toBe("pod-1");
    expect(card.audio_url).toBe("/media/podcast/newest-podcast/episode.m4a");
  });

  test("404s for missing cards", async () => {
    const res = await app.request("/api/cards/podcast/nope");
    expect(res.status).toBe(404);
  });
});

describe("GET /media/:type/:slug/:file", () => {
  test("serves media files with content type and full body", async () => {
    const res = await app.request("/media/podcast/newest-podcast/hero.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect((await res.arrayBuffer()).byteLength).toBe(4);
  });

  test("serves .m4a as audio/mp4 (Bun's mime table says audio/x-m4a)", async () => {
    const res = await app.request("/media/podcast/newest-podcast/episode.m4a");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mp4");
    expect((await res.arrayBuffer()).byteLength).toBe(14);
  });

  test(".m4a Range responses keep the audio/mp4 content type", async () => {
    const res = await app.request("/media/podcast/newest-podcast/episode.m4a", {
      headers: { range: "bytes=0-3" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("audio/mp4");
    expect(res.headers.get("content-range")).toBe("bytes 0-3/14");
  });

  test("honors Range requests (required for audio seek on iOS)", async () => {
    const res = await app.request("/media/podcast/newest-podcast/episode.wav", {
      headers: { range: "bytes=0-3" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-3/14");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf]).toEqual([0x52, 0x49, 0x46, 0x46]); // "RIFF"
  });

  test("handles open-ended and suffix ranges", async () => {
    const open = await app.request("/media/podcast/newest-podcast/episode.wav", {
      headers: { range: "bytes=10-" },
    });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 10-13/14");

    const suffix = await app.request("/media/podcast/newest-podcast/episode.wav", {
      headers: { range: "bytes=-4" },
    });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 10-13/14");
  });

  test("416s for unsatisfiable ranges", async () => {
    const res = await app.request("/media/podcast/newest-podcast/episode.wav", {
      headers: { range: "bytes=999-" },
    });
    expect(res.status).toBe(416);
  });

  test("blocks path traversal out of the artifacts dir", async () => {
    const res = await app.request("/media/podcast/newest-podcast/..%2F..%2F..%2Fetc%2Fpasswd");
    expect([403, 404]).toContain(res.status);
  });

  test("404s for missing media", async () => {
    const res = await app.request("/media/podcast/newest-podcast/missing.png");
    expect(res.status).toBe(404);
  });
});

describe("static SPA", () => {
  test("serves index.html at /", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>feed</title>");
  });

  test("falls back to index.html for unknown paths", async () => {
    const res = await app.request("/some/client/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>feed</title>");
  });
});
