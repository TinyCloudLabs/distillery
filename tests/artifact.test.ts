import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugify,
  validateArtifact,
  writeArtifact,
  type Artifact,
} from "../skills/_shared/lib/artifact.ts";

function goodArtifact(): Artifact {
  return {
    id: "a-1",
    type: "insight-card",
    headline: "Usage-based pricing aligns revenue with value",
    body: "The team chose usage-based pricing because seats punish power users.",
    quote: "Seats punish our best users.",
    attribution: "Ada Lovelace",
    tags: ["pricing", "strategy"],
    source_transcripts: ["/tmp/fireflies-style.md"],
    source_quotes: [
      {
        quote: "Seats punish our best users.",
        speaker: "Ada Lovelace",
        transcript: "/tmp/fireflies-style.md",
      },
    ],
    generated_at: "2026-06-10T12:00:00.000Z",
    generation_model: "agent-judgment",
    quality: { critic_pass: true, quotes_verified: true, notes: "1 of 3 candidates survived" },
  };
}

describe("validateArtifact", () => {
  test("accepts a contract-valid artifact", () => {
    const result = validateArtifact(goodArtifact());
    expect(result.ok).toBe(true);
  });

  test("rejects non-objects", () => {
    expect(validateArtifact(null).ok).toBe(false);
    expect(validateArtifact("x").ok).toBe(false);
    expect(validateArtifact([]).ok).toBe(false);
  });

  test("requires id, headline, type, generated_at, tags, sources, quality", () => {
    const result = validateArtifact({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const all = result.errors.join("\n");
    for (const field of [
      "id",
      "headline",
      "type",
      "generated_at",
      "tags",
      "source_transcripts",
      "quality",
    ]) {
      expect(all).toContain(field);
    }
  });

  test("rejects unknown artifact types", () => {
    const a = { ...goodArtifact(), type: "tweetstorm" };
    const result = validateArtifact(a);
    expect(result.ok).toBe(false);
  });

  test("rejects empty source_transcripts", () => {
    const a = { ...goodArtifact(), source_transcripts: [] };
    expect(validateArtifact(a).ok).toBe(false);
  });

  test("rejects malformed quality block", () => {
    const a = { ...goodArtifact(), quality: { critic_pass: "yes" } };
    const result = validateArtifact(a);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.join("\n")).toContain("quality.critic_pass");
    expect(result.errors.join("\n")).toContain("quality.quotes_verified");
  });

  test("rejects malformed source_quotes entries", () => {
    const a = { ...goodArtifact(), source_quotes: [{ speaker: "Ada" }] };
    const result = validateArtifact(a);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.join("\n")).toContain("source_quotes[0].quote");
  });

  test("rejects non-ISO generated_at", () => {
    const a = { ...goodArtifact(), generated_at: "yesterday-ish" };
    expect(validateArtifact(a).ok).toBe(false);
  });
});

describe("slugify", () => {
  test("kebab-cases and truncates", () => {
    expect(slugify("Usage-Based Pricing — Aligns Revenue!")).toBe(
      "usage-based-pricing-aligns-revenue",
    );
    expect(slugify("")).toBe("untitled");
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(64);
  });
});

describe("writeArtifact", () => {
  test("writes artifacts/<type>/<slug>/artifact.json plus media", async () => {
    const dir = await mkdtemp(join(tmpdir(), "distillery-"));
    try {
      const artifact = goodArtifact();
      const media = new TextEncoder().encode("fake-png-bytes");
      const written = await writeArtifact(artifact, {
        outDir: dir,
        media: { "hero.png": media },
      });
      expect(written.jsonPath).toBe(
        join(dir, "insight-card", slugify(artifact.headline), "artifact.json"),
      );
      const roundTrip = JSON.parse(await readFile(written.jsonPath, "utf8"));
      expect(roundTrip.headline).toBe(artifact.headline);
      expect(roundTrip.quality.quotes_verified).toBe(true);
      const hero = await readFile(join(written.dir, "hero.png"));
      expect(new Uint8Array(hero)).toEqual(media);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses to write invalid artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "distillery-"));
    try {
      const bad = { ...goodArtifact(), headline: "" } as Artifact;
      expect(writeArtifact(bad, { outDir: dir })).rejects.toThrow("Invalid artifact");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
