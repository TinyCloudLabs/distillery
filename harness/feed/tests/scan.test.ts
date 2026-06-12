import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { scanArtifacts } from "../src/scan.ts";
import { makeFixture, type Fixture } from "./fixtures.ts";

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

describe("scanArtifacts", () => {
  test("returns only valid artifacts, skipping broken json and empty dirs", async () => {
    const cards = await scanArtifacts(fx.dir);
    // The scanner is ROUTING-AGNOSTIC: it returns every valid artifact (internal
    // AND outward, pending or approved). Routing is the app layer's job.
    expect(cards.map((c) => c.id).sort()).toEqual([
      "approved-snippet-1",
      "art-1",
      "draft-blank-status-1",
      "draft-missing-status-1",
      "draft-pending-1",
      "ins-1",
      "pod-1",
      "unk-1",
    ]);
  });

  test("sorts newest first by generated_at", async () => {
    const cards = await scanArtifacts(fx.dir);
    expect(cards.map((c) => c.id)).toEqual([
      "pod-1",
      "draft-pending-1",
      "draft-missing-status-1",
      "draft-blank-status-1",
      "ins-1",
      "approved-snippet-1",
      "unk-1",
      "art-1",
    ]);
  });

  test("maps media URLs only for files that exist", async () => {
    const cards = await scanArtifacts(fx.dir);
    const pod = cards.find((c) => c.id === "pod-1")!;
    expect(pod.audio_url).toBe("/media/podcast/newest-podcast/episode.m4a");
    expect(pod.hero_image_url).toBe("/media/podcast/newest-podcast/hero.png");

    // hero_image referenced but missing on disk → no URL emitted
    const ins = cards.find((c) => c.id === "ins-1")!;
    expect(ins.hero_image).toBe("hero.png");
    expect(ins.hero_image_url).toBeUndefined();
  });

  test("normalizes missing optional fields gracefully", async () => {
    const cards = await scanArtifacts(fx.dir);
    const art = cards.find((c) => c.id === "art-1")!;
    expect(art.tags).toEqual([]);
    expect(art.quality).toBeUndefined();
    expect(art.slug).toBe("oldest-article");
  });

  test("prefers body.md sidecar for article bodies", async () => {
    const cards = await scanArtifacts(fx.dir);
    const art = cards.find((c) => c.id === "art-1")!;
    expect(art.body).toBe("# Full article\n\nFrom body.md.");
  });

  test("surfaces unknown artifact types as cards", async () => {
    const cards = await scanArtifacts(fx.dir);
    const unk = cards.find((c) => c.id === "unk-1")!;
    expect(unk.type).toBe("fever-dream");
    expect(unk.headline).toBe("Unknown type artifact");
  });

  test("returns empty array for a nonexistent artifacts dir", async () => {
    const cards = await scanArtifacts("/nonexistent/definitely-not-here");
    expect(cards).toEqual([]);
  });
});
