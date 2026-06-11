// corpus-query.test.ts — query-corpus plumbing (§3): each filter dimension,
// the surfaced join (artifact baseline ∪ ledger), the deep-dive cursor
// advance/wrap, and empty-index grace.
//
// All transcript content here is SYNTHETIC — never real meeting text.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CorpusIndex,
  IndexRecord,
} from "../skills/index-corpus/scripts/corpus-index.ts";
import type { PriorArtifactIndex } from "../skills/_shared/lib/novelty.ts";
import {
  queryCorpus,
  buildSurfacedJoin,
  renderQueryMarkdown,
} from "../skills/query-corpus/scripts/corpus-query.ts";
import {
  advanceCursor,
  appendSurfaced,
  emptyLedger,
  readLedger,
  writeLedger,
  ledgerSurfacedPaths,
  type SurfacedLedger,
} from "../skills/query-corpus/scripts/surfaced-ledger.ts";

// --- synthetic index fixtures (no real content) ---------------------------

function rec(over: Partial<IndexRecord> & Pick<IndexRecord, "path">): IndexRecord {
  return {
    source: "fireflies",
    title: "Untitled",
    date: "2026-06-08",
    speakers: ["Ada", "Grace"],
    speakerTurnCounts: { Ada: 3, Grace: 2 },
    turnCount: 5,
    duration: "10 min",
    entities: ["OpenKey"],
    terms: ["permissioning"],
    quantities: [],
    content_hash: "sha256:deadbeef",
    indexed_at: "2026-06-08T00:00:00Z",
    empty: false,
    ...over,
  };
}

const A = "/corpus/Fireflies-Transcripts/2026-06-04-alpha.md";
const B = "/corpus/Gemini-Transcripts/2026-06-08-bravo.md";
const C = "/corpus/Soundcore-Transcripts/2026-06-10-charlie.md";
const D = "/corpus/Fireflies-Transcripts/2026-06-12-delta.md";

function makeIndex(): CorpusIndex {
  return {
    version: 1,
    generated_at: "2026-06-12T00:00:00Z",
    transcript_dirs: ["/corpus"],
    transcripts: [
      rec({
        path: A,
        source: "fireflies",
        date: "2026-06-04",
        title: "Alpha",
        speakers: ["Ada", "Sam"],
        entities: ["OpenKey", "Flashbots"],
        terms: ["permissioning"],
        quantities: [
          { kind: "money", value: "$100k", speaker: "Sam", timestamp: "12:56", context: "close the OpenKey round at $100k by Friday" },
        ],
      }),
      rec({
        path: B,
        source: "gemini",
        date: "2026-06-08",
        title: "Bravo",
        speakers: ["Hunter", "Grace"],
        entities: ["Delegation"],
        terms: ["onboarding"],
        quantities: [
          { kind: "count", value: "10 customers", speaker: "Hunter", context: "we want 10 customers before the demo" },
        ],
      }),
      rec({
        path: C,
        source: "soundcore",
        date: "2026-06-10",
        title: "Charlie",
        speakers: ["Ada", "Grace"],
        entities: ["OpenKey"],
        terms: ["pricing"],
        quantities: [],
      }),
      rec({
        path: D,
        source: "fireflies",
        date: "2026-06-12",
        title: "Delta (empty)",
        speakers: [],
        speakerTurnCounts: {},
        turnCount: 0,
        entities: [],
        terms: [],
        quantities: [],
        empty: true,
      }),
    ],
    warnings: [],
  };
}

const emptyBaseline = (): PriorArtifactIndex => ({
  artifactsDir: "artifacts",
  entries: [],
  warnings: [],
});

// === filter dimensions =====================================================

describe("query filters", () => {
  test("date window (inclusive, both bounds) — and matched_on records the bounds", () => {
    const r = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), {
      since: "2026-06-05",
      until: "2026-06-10",
    });
    expect(r.matches.map((m) => m.path)).toEqual([C, B]); // newest first, D excluded (empty)
    expect(r.matches.find((m) => m.path === B)!.matched_on).toEqual(["since", "until"]);
  });

  test("since-only and until-only bounds", () => {
    const since = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), { since: "2026-06-08" });
    expect(since.matches.map((m) => m.path)).toEqual([C, B]); // D empty-excluded
    const until = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), { until: "2026-06-04" });
    expect(until.matches.map((m) => m.path)).toEqual([A]);
  });

  test("speaker filter (case-insensitive)", () => {
    const r = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), { speaker: "sam" });
    expect(r.matches.map((m) => m.path)).toEqual([A]);
    expect(r.matches[0]!.matched_on).toEqual(["speaker"]);
  });

  test("entity filter (case-insensitive) hits multiple", () => {
    const r = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), { entity: "openkey" });
    expect(r.matches.map((m) => m.path)).toEqual([C, A]); // newest first
  });

  test("term filter", () => {
    const r = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), { term: "pricing" });
    expect(r.matches.map((m) => m.path)).toEqual([C]);
  });

  test("source filter", () => {
    const r = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), { source: "gemini" });
    expect(r.matches.map((m) => m.path)).toEqual([B]);
  });

  test("filters AND together (entity + source)", () => {
    const both = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), {
      entity: "OpenKey",
      source: "soundcore",
    });
    expect(both.matches.map((m) => m.path)).toEqual([C]);
    expect(both.matches[0]!.matched_on.sort()).toEqual(["entity", "source"]);
    // The same entity in a different source is excluded by the AND.
    const none = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), {
      entity: "Flashbots",
      source: "soundcore",
    });
    expect(none.matches).toHaveLength(0);
  });

  test("no filters returns whole index (empty excluded), newest first", () => {
    const r = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), {});
    expect(r.matches.map((m) => m.path)).toEqual([C, B, A]);
  });

  test("--include-empty surfaces the flagged-empty record", () => {
    const r = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), { includeEmpty: true });
    expect(r.matches.map((m) => m.path)).toEqual([D, C, B, A]);
  });

  test("limit caps after sorting", () => {
    const r = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), { limit: 2 });
    expect(r.matches.map((m) => m.path)).toEqual([C, B]);
    expect(r.counts.total).toBe(2);
  });

  test("match_context pulls quantity context mentioning the filtered entity", () => {
    const r = queryCorpus(makeIndex(), emptyBaseline(), emptyLedger(), { entity: "OpenKey" });
    const alpha = r.matches.find((m) => m.path === A)!;
    expect(alpha.match_context.some((c) => c.includes("$100k"))).toBe(true);
  });
});

// === surfaced join =========================================================

describe("surfaced join (artifact baseline ∪ ledger)", () => {
  test("artifact baseline marks a transcript surfaced (exact path)", () => {
    const baseline: PriorArtifactIndex = {
      artifactsDir: "artifacts",
      entries: [
        {
          path: "artifacts/insight-card/foo/artifact.json",
          type: "insight-card",
          slug: "foo",
          headline: "h",
          tags: [],
          source_transcripts: [A],
          source_quotes: [],
        },
      ],
      warnings: [],
    };
    const r = queryCorpus(makeIndex(), baseline, emptyLedger(), {});
    const a = r.matches.find((m) => m.path === A)!;
    expect(a.surfaced).toBe(true);
    expect(a.surfaced_by).toContain("artifact:insight-card/foo");
    expect(r.matches.find((m) => m.path === B)!.surfaced).toBe(false);
    expect(r.counts.surfaced).toBe(1);
  });

  test("artifact baseline matches on basename when it stored a relative path", () => {
    const baseline: PriorArtifactIndex = {
      artifactsDir: "artifacts",
      entries: [
        {
          path: "artifacts/article/bar/artifact.json",
          type: "article",
          slug: "bar",
          headline: "h",
          tags: [],
          // recorded as a bare basename, not the absolute index key
          source_transcripts: ["2026-06-08-bravo.md"],
          source_quotes: [],
        },
      ],
      warnings: [],
    };
    const r = queryCorpus(makeIndex(), baseline, emptyLedger(), {});
    const b = r.matches.find((m) => m.path === B)!;
    expect(b.surfaced).toBe(true);
    expect(b.surfaced_by).toContain("artifact:article/bar");
  });

  test("ledger marks a transcript surfaced (examined-no-ship still counts)", () => {
    let ledger = emptyLedger();
    ledger = appendSurfaced(ledger, {
      path: C,
      topic_keys: ["openkey,pricing"],
      run_id: "2026-06-10T14:00Z",
      outcome: "examined-no-ship",
      mode: "deepdive",
    });
    const r = queryCorpus(makeIndex(), emptyBaseline(), ledger, {});
    const c = r.matches.find((m) => m.path === C)!;
    expect(c.surfaced).toBe(true);
    expect(c.surfaced_by).toContain("ledger:2026-06-10T14:00Z");
  });

  test("union: a transcript in BOTH sources lists both provenances, deduped", () => {
    const baseline: PriorArtifactIndex = {
      artifactsDir: "artifacts",
      entries: [
        {
          path: "artifacts/insight-card/foo/artifact.json",
          type: "insight-card",
          slug: "foo",
          headline: "h",
          tags: [],
          source_transcripts: [A],
          source_quotes: [],
        },
      ],
      warnings: [],
    };
    let ledger = emptyLedger();
    ledger = appendSurfaced(ledger, {
      path: A,
      topic_keys: ["openkey"],
      run_id: "2026-06-05T14:00Z",
      outcome: "shipped",
      mode: "recency",
    });
    const r = queryCorpus(makeIndex(), baseline, ledger, {});
    const a = r.matches.find((m) => m.path === A)!;
    expect(a.surfaced).toBe(true);
    expect(a.surfaced_by.sort()).toEqual([
      "artifact:insight-card/foo",
      "ledger:2026-06-05T14:00Z",
    ]);
  });

  test("--unsurfaced-only drops surfaced matches and updates counts", () => {
    let ledger = emptyLedger();
    ledger = appendSurfaced(ledger, {
      path: C,
      topic_keys: [],
      run_id: "r1",
      outcome: "shipped",
      mode: "recency",
    });
    const baseline: PriorArtifactIndex = {
      artifactsDir: "artifacts",
      entries: [
        {
          path: "x/artifact.json",
          type: "article",
          slug: "x",
          headline: "h",
          tags: [],
          source_transcripts: [B],
          source_quotes: [],
        },
      ],
      warnings: [],
    };
    const r = queryCorpus(makeIndex(), baseline, ledger, { unsurfacedOnly: true });
    expect(r.matches.map((m) => m.path)).toEqual([A]); // B + C surfaced, D empty
    expect(r.counts).toEqual({ total: 1, surfaced: 0, unsurfaced: 1 });
  });

  test("buildSurfacedJoin closure is reusable across paths", () => {
    const baseline: PriorArtifactIndex = {
      artifactsDir: "artifacts",
      entries: [
        {
          path: "x/artifact.json",
          type: "article",
          slug: "x",
          headline: "h",
          tags: [],
          source_transcripts: [A, B],
          source_quotes: [],
        },
      ],
      warnings: [],
    };
    const join = buildSurfacedJoin(baseline, emptyLedger());
    expect(join(A)).toContain("artifact:article/x");
    expect(join(B)).toContain("artifact:article/x");
    expect(join(C)).toEqual([]);
  });
});

// === deep-dive cursor advance / wrap =======================================

describe("deep-dive cursor", () => {
  const ordered = [A, B, C, D]; // a stable candidate ordering

  test("first run (no cursor) starts at the first candidate, not a wrap", () => {
    const { next, ledger, wrapped } = advanceCursor(emptyLedger(), ordered);
    expect(next).toBe(A);
    expect(wrapped).toBe(false);
    expect(ledger.deepdive_cursor.last_path).toBe(A);
  });

  test("advances exactly one per run", () => {
    let ledger = emptyLedger();
    ({ ledger } = advanceCursor(ledger, ordered)); // → A
    let res = advanceCursor(ledger, ordered); // → B
    expect(res.next).toBe(B);
    expect(res.wrapped).toBe(false);
    res = advanceCursor(res.ledger, ordered); // → C
    expect(res.next).toBe(C);
  });

  test("wraps to the first candidate after the end", () => {
    let ledger: SurfacedLedger = { ...emptyLedger(), deepdive_cursor: { last_path: D } };
    const res = advanceCursor(ledger, ordered);
    expect(res.next).toBe(A);
    expect(res.wrapped).toBe(true);
    expect(res.ledger.deepdive_cursor.last_path).toBe(A);
  });

  test("cursor pointing at a path no longer a candidate wraps to first", () => {
    const ledger: SurfacedLedger = {
      ...emptyLedger(),
      deepdive_cursor: { last_path: "/gone/removed.md" },
    };
    const res = advanceCursor(ledger, [B, C]);
    expect(res.next).toBe(B);
    expect(res.wrapped).toBe(true);
  });

  test("empty candidate list leaves the cursor unchanged (recency-only run)", () => {
    const ledger: SurfacedLedger = { ...emptyLedger(), deepdive_cursor: { last_path: B } };
    const res = advanceCursor(ledger, []);
    expect(res.next).toBeUndefined();
    expect(res.wrapped).toBe(false);
    expect(res.ledger.deepdive_cursor.last_path).toBe(B);
  });

  test("a full lap visits every candidate once then wraps", () => {
    let ledger = emptyLedger();
    const visited: string[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const res = advanceCursor(ledger, ordered);
      visited.push(res.next!);
      ledger = res.ledger;
    }
    expect(visited).toEqual(ordered);
    const wrap = advanceCursor(ledger, ordered);
    expect(wrap.next).toBe(A);
    expect(wrap.wrapped).toBe(true);
  });
});

// === ledger persistence ====================================================

describe("ledger persistence", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "surfaced-ledger-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("write then read round-trips entries + cursor", async () => {
    let ledger = emptyLedger();
    ledger = appendSurfaced(ledger, {
      path: A,
      topic_keys: ["openkey"],
      run_id: "r1",
      outcome: "shipped",
      mode: "recency",
      content_hash: "sha256:abc",
    });
    ledger = { ...ledger, deepdive_cursor: { last_path: B } };
    const p = join(dir, "surfaced.json");
    await writeLedger(p, ledger);
    const back = await readLedger(p);
    expect(back.surfaced).toHaveLength(1);
    expect(back.surfaced[0]!.content_hash).toBe("sha256:abc");
    expect(back.deepdive_cursor.last_path).toBe(B);
  });

  test("missing ledger file reads as empty (never throws)", async () => {
    const back = await readLedger(join(dir, "nope.json"));
    expect(back).toEqual(emptyLedger());
  });

  test("corrupt ledger file reads as empty (never throws)", async () => {
    const p = join(dir, "corrupt.json");
    await writeFile(p, "{ this is not json", "utf8");
    expect(await readLedger(p)).toEqual(emptyLedger());
  });

  test("ledgerSurfacedPaths collects every recorded path", () => {
    let ledger = emptyLedger();
    ledger = appendSurfaced(ledger, { path: A, topic_keys: [], run_id: "r1", outcome: "shipped", mode: "recency" });
    ledger = appendSurfaced(ledger, { path: B, topic_keys: [], run_id: "r2", outcome: "examined-no-ship", mode: "deepdive" });
    expect(ledgerSurfacedPaths(ledger)).toEqual(new Set([A, B]));
  });
});

// === empty-index grace + markdown ==========================================

describe("empty-index grace + rendering", () => {
  test("empty index yields zero matches, never throws", () => {
    const empty: CorpusIndex = {
      version: 1,
      generated_at: "2026-06-12T00:00:00Z",
      transcript_dirs: [],
      transcripts: [],
      warnings: [],
    };
    const r = queryCorpus(empty, emptyBaseline(), emptyLedger(), { entity: "OpenKey" });
    expect(r.matches).toHaveLength(0);
    expect(r.counts).toEqual({ total: 0, surfaced: 0, unsurfaced: 0 });
  });

  test("markdown report includes counts and the surfaced mark", () => {
    let ledger = emptyLedger();
    ledger = appendSurfaced(ledger, { path: C, topic_keys: [], run_id: "rX", outcome: "shipped", mode: "recency" });
    const r = queryCorpus(makeIndex(), emptyBaseline(), ledger, { entity: "OpenKey" });
    const md = renderQueryMarkdown(r);
    expect(md).toContain("# Corpus query");
    expect(md).toContain("surfaced:");
    expect(md).toContain("✓ surfaced");
    expect(md).toContain("ledger:rX");
  });

  test("markdown handles no matches", () => {
    const empty: CorpusIndex = {
      version: 1, generated_at: "x", transcript_dirs: [], transcripts: [], warnings: [],
    };
    const md = renderQueryMarkdown(queryCorpus(empty, emptyBaseline(), emptyLedger(), {}));
    expect(md).toContain("- (none)");
  });
});
