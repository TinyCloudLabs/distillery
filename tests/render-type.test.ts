import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_TYPES,
  FORMAT_REGISTRY,
  renderTypeFor,
  type ArtifactType,
} from "../skills/_shared/lib/formats.ts";
import { ARTIFACT_DBS } from "../skills/_shared/lib/artifact-schema.ts";

// The §4.2 mapping is the single source of truth for how the viewer draws each
// of the 8 distillery types. These tests pin the mapping so a registry edit
// can't silently change a card shape, and confirm the V1 render set.

describe("renderTypeFor — §4.2 mapping", () => {
  const expected: Record<ArtifactType, "tweet" | "article" | "video"> = {
    "social-post": "tweet",
    "quote-card": "tweet",
    "investor-update-snippet": "tweet",
    article: "article",
    "insight-card": "article",
    digest: "article",
    podcast: "article",
    "person-brief": "article",
  };

  for (const type of ARTIFACT_TYPES) {
    test(`${type} → ${expected[type]}`, () => {
      expect(renderTypeFor(type)).toBe(expected[type]);
    });
  }

  test("every registry entry carries a render shape", () => {
    for (const type of ARTIFACT_TYPES) {
      expect(["tweet", "article", "video"]).toContain(
        FORMAT_REGISTRY[type].render,
      );
    }
  });

  test("V1 produces only tweet + article (video deferred)", () => {
    const shapes = new Set(ARTIFACT_TYPES.map(renderTypeFor));
    expect(shapes.has("tweet")).toBe(true);
    expect(shapes.has("article")).toBe(true);
    expect(shapes.has("video")).toBe(false);
  });
});

describe("artifact schema — §1 DDL", () => {
  test("defines the three application-space databases", () => {
    const dbs = ARTIFACT_DBS.map((d) => d.db);
    expect(dbs).toEqual([
      "xyz.tinycloud.artifacts/feed",
      "xyz.tinycloud.artifacts/interactions",
      "xyz.tinycloud.artifacts/control",
    ]);
  });

  test("each DB has exactly one CREATE TABLE statement", () => {
    for (const db of ARTIFACT_DBS) {
      expect(db.tables.length).toBe(1);
      expect(db.tables[0]).toMatch(/CREATE TABLE IF NOT EXISTS/);
    }
  });

  test("feed.artifact has approval_status NOT NULL with no DEFAULT", () => {
    const feed = ARTIFACT_DBS[0]!.tables[0]!;
    expect(feed).toMatch(/approval_status\s+TEXT NOT NULL,/);
    expect(feed).not.toMatch(/approval_status\s+TEXT NOT NULL DEFAULT/);
  });

  test("interaction carries nonce + recorded_at for replay protection", () => {
    const interactions = ARTIFACT_DBS[1]!.tables[0]!;
    expect(interactions).toMatch(/nonce\s+TEXT NOT NULL/);
    expect(interactions).toMatch(/recorded_at\s+TEXT NOT NULL/);
  });

  test("all DDL statements are idempotent (IF NOT EXISTS)", () => {
    for (const db of ARTIFACT_DBS) {
      for (const stmt of [...db.tables, ...db.indexes]) {
        expect(stmt).toMatch(/IF NOT EXISTS/);
      }
    }
  });
});

describe("listenReadCaps — §3.3 grant #1 spec", () => {
  const OWNER = "tinycloud:pkh:eip155:1:0xOWNER:applications";
  test("emits SQL conversations:read + KV transcript prefix get,list,metadata", async () => {
    const { listenReadCaps } = await import(
      "../skills/tc-listen-read/scripts/listen-read-lib.ts"
    );
    const caps = listenReadCaps(OWNER);
    expect(caps).toEqual([
      `tinycloud.sql:${OWNER}:xyz.tinycloud.listen/conversations:read`,
      `tinycloud.kv:${OWNER}:xyz.tinycloud.listen/:get,list,metadata`,
    ]);
  });
  test("KV prefix cap keeps the load-bearing trailing slash", async () => {
    const { listenReadCaps } = await import(
      "../skills/tc-listen-read/scripts/listen-read-lib.ts"
    );
    const kvCap = listenReadCaps(OWNER)[1]!;
    expect(kvCap).toContain("xyz.tinycloud.listen/:");
  });
});
