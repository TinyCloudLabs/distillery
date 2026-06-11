import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectQuantityMentions,
  extractQuantities,
  extractTranscriptTerms,
  findSingleVoiceTopics,
  priorArtifactIndex,
  trackQuantities,
} from "../skills/_shared/lib/novelty.ts";
import { parseTranscript } from "../skills/_shared/lib/transcript.ts";

// Synthetic fixtures only — never real meeting content. Quantity shapes
// mirror what real spoken transcripts contain ("$100k", "100 grand",
// "3 to 5 million bucks", "20%", "by Friday", "10 people").

// ---------------------------------------------------------------------------
// extractQuantities — pattern coverage
// ---------------------------------------------------------------------------

describe("extractQuantities", () => {
  const kindsOf = (text: string) => extractQuantities(text).map((m) => m.kind);
  const valuesOf = (text: string) => extractQuantities(text).map((m) => m.value);

  test("money: $ symbol forms", () => {
    expect(valuesOf("We need $100k to close and $50,000 committed.")).toEqual([
      "$100k",
      "$50,000",
    ]);
    expect(kindsOf("$7.5 million for the seed")).toEqual(["money"]);
  });

  test("money: spoken scale forms", () => {
    expect(valuesOf("There is 100 grand to close.")).toEqual(["100 grand"]);
    expect(valuesOf("We should get 3 to 5 million bucks off the token.")).toEqual([
      "3 to 5 million bucks",
    ]);
    expect(valuesOf("Maybe a hundred grand more.")).toEqual(["a hundred grand"]);
  });

  test("percent: % and spelled", () => {
    expect(kindsOf("Churn dropped 20% after the change.")).toEqual(["percent"]);
    expect(kindsOf("Give them 20 percent of the equity.")).toEqual(["percent"]);
  });

  test("counts with units", () => {
    const matches = extractQuantities("We onboarded 10 people across 3 meetings.");
    expect(matches.map((m) => [m.kind, m.value])).toEqual([
      ["count", "10 people"],
      ["count", "3 meetings"],
    ]);
  });

  test("deadlines", () => {
    expect(valuesOf("The deck is due by Friday, demo by June 15.")).toEqual([
      "by Friday",
      "by June 15",
    ]);
    expect(kindsOf("We target the end of July for launch.")).toEqual(["deadline"]);
  });

  test("money beats count on overlap: '5 million bucks' is not a count", () => {
    const matches = extractQuantities("That's 5 million bucks of pipeline.");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.kind).toBe("money");
  });

  test("no false positives on plain prose", () => {
    expect(extractQuantities("Let's sync about the roadmap tomorrow.")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// trackQuantities — grouping + chronology + provenance
// ---------------------------------------------------------------------------

const MEETING_ONE = `# Sync One
**Date:** 2026-03-01

## Transcript

**Ada Lovelace (00:05:00):**
The bridge round needs $100k to close before the accelerator demo day.

**Grace Hopper:**
Right, and the cache migration is unrelated to the bridge round.
`;

const MEETING_TWO = `# Sync Two
**Date:** 2026-03-15

## Transcript

**Ada Lovelace (00:02:00):**
We still need 50 grand to close the bridge round, half of what it was.

**Grace Hopper:**
Separately, churn hit 12% on the analytics cohort this month.
`;

describe("trackQuantities", () => {
  const transcripts = [
    parseTranscript(MEETING_TWO, "/tmp/two.md"), // out of order on purpose
    parseTranscript(MEETING_ONE, "/tmp/one.md"),
  ];
  const track = trackQuantities(transcripts);

  test("groups same-topic money mentions across transcripts", () => {
    const drift = track.groups.find((g) =>
      g.mentions.some((m) => m.value === "$100k"),
    );
    expect(drift).toBeDefined();
    expect(drift!.transcripts).toEqual(["/tmp/one.md", "/tmp/two.md"]);
    expect(drift!.mentions.map((m) => m.value)).toEqual(["$100k", "50 grand"]);
    // Topic key reflects the shared context ("bridge"/"close"/"round").
    expect(drift!.topicKey.length).toBeGreaterThanOrEqual(2);
    expect(drift!.topicKey).toContain("bridge");
  });

  test("mentions are chronological with full provenance", () => {
    const drift = track.groups.find((g) =>
      g.mentions.some((m) => m.value === "$100k"),
    )!;
    const [first, second] = drift.mentions;
    expect(first!.date).toBe("2026-03-01");
    expect(second!.date).toBe("2026-03-15");
    expect(first!.speaker).toBe("Ada Lovelace");
    expect(first!.timestamp).toBe("00:05:00");
    expect(first!.turnIndex).toBe(0);
    expect(first!.context).toContain("$100k");
  });

  test("unrelated quantity stays a notable single", () => {
    const single = track.singles.find((m) => m.value.startsWith("12"));
    expect(single).toBeDefined();
    expect(single!.kind).toBe("percent");
    expect(single!.transcript).toBe("/tmp/two.md");
  });

  test("AI summary headers are not mined (spoken turns only)", () => {
    const withSummary = parseTranscript(
      `# Solo
**Date:** 2026-03-02

## Summary
- The team secured $999,999 in imaginary header money.

## Transcript

**Ada Lovelace:**
No numbers were spoken aloud here.
`,
      "/tmp/summary.md",
    );
    const t = trackQuantities([withSummary]);
    expect(t.groups).toEqual([]);
    expect(t.singles).toEqual([]);
  });

  test("time-unit counts are excluded from singles as noise", () => {
    const t = trackQuantities([
      parseTranscript(
        "## Transcript\n\n**Ada Lovelace:**\nLet's keep it to 30 minutes.\n",
        "/tmp/noise.md",
      ),
    ]);
    expect(t.singles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findSingleVoiceTopics — asymmetric-knowledge candidates
// ---------------------------------------------------------------------------

// Ada is the only person who ever says "Quicksilver" (engaged reply once,
// back-channel only the other time); both speakers say "Roadmap"; Grace
// alone says "telemetry" repeatedly with zero substantive response.
const SV_ONE = `# Sync One
**Date:** 2026-03-01

## Transcript

**Ada Lovelace:**
The whole migration depends on Quicksilver and its retry semantics, which nobody else has touched.

**Grace Hopper:**
Can you walk me through how that retry interacts with our queue? I want details.

**Ada Lovelace:**
Sure. Also Quicksilver handles dedupe for us, remember that detail.

**Grace Hopper:**
Ok.

**Grace Hopper:**
On observability, the telemetry pipeline buffering is misconfigured again.

**Grace Hopper:**
And telemetry drops spans under load, which hides the real failure.

**Grace Hopper:**
Nobody reviews the telemetry dashboards either.

**Ada Lovelace:**
Hm.
`;

const SV_TWO = `# Sync Two
**Date:** 2026-03-08

## Transcript

**Ada Lovelace:**
Updating the Roadmap today.

**Grace Hopper:**
The Roadmap looks fine to me after the review we did together yesterday.
`;

describe("findSingleVoiceTopics", () => {
  const transcripts = [
    parseTranscript(SV_ONE, "/tmp/sv-one.md"),
    parseTranscript(SV_TWO, "/tmp/sv-two.md"),
  ];
  const topics = findSingleVoiceTopics(transcripts);

  test("detects a capitalized entity only one speaker uses", () => {
    const qs = topics.find((t) => t.term === "quicksilver");
    expect(qs).toBeDefined();
    expect(qs!.speaker).toBe("Ada Lovelace");
    expect(qs!.entity).toBe(true);
    expect(qs!.mentionCount).toBe(2);
    expect(qs!.mentions[0]!.context).toContain("Quicksilver");
  });

  test("engagement signal: substantive reply vs back-channel", () => {
    const qs = topics.find((t) => t.term === "quicksilver")!;
    // First mention got Grace's real question; second only got "Ok." then a
    // topic change by Grace (still >= 40 chars => engaged). Check per-mention.
    expect(qs.mentions[0]!.engaged).toBe(true);
    expect(qs.engagedCount).toBeGreaterThanOrEqual(1);
  });

  test("zero-engagement single-voice topic is flagged", () => {
    const tel = topics.find((t) => t.term === "telemetry");
    expect(tel).toBeDefined();
    expect(tel!.speaker).toBe("Grace Hopper");
    // Only Ada's "Hm." follows — below the substantive threshold.
    expect(tel!.engagedCount).toBe(0);
    expect(tel!.mentions.every((m) => !m.engaged)).toBe(true);
  });

  test("terms echoed by a second speaker are excluded", () => {
    expect(topics.find((t) => t.term === "roadmap")).toBeUndefined();
  });

  test("speaker names are never topics", () => {
    expect(topics.find((t) => t.term.includes("ada"))).toBeUndefined();
    expect(topics.find((t) => t.term.includes("lovelace"))).toBeUndefined();
  });

  test("single mentions fall below the default threshold", () => {
    // "dedupe" said once by Ada — lowercase words need 3 mentions by default.
    expect(topics.find((t) => t.term === "dedupe")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// priorArtifactIndex — the novelty baseline
// ---------------------------------------------------------------------------

describe("priorArtifactIndex", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "novelty-artifacts-"));
    const cardDir = join(dir, "insight-card", "old-card");
    await mkdir(cardDir, { recursive: true });
    await writeFile(
      join(cardDir, "artifact.json"),
      JSON.stringify({
        id: "1",
        type: "insight-card",
        headline: "The bridge round is $100K from closing",
        tags: ["fundraising"],
        quote: "100 grand to close",
        source_transcripts: ["/tmp/one.md"],
        source_quotes: [{ quote: "100 grand to close", transcript: "/tmp/one.md" }],
        generated_at: "2026-03-02T00:00:00Z",
        quality: { critic_pass: true, quotes_verified: true, notes: "[novelty] lead=quantified-drift" },
      }),
    );
    const podDir = join(dir, "podcast", "older-episode");
    await mkdir(podDir, { recursive: true });
    await writeFile(
      join(podDir, "artifact.json"),
      JSON.stringify({
        id: "2",
        type: "podcast",
        headline: "Why the cache melts on deploy",
        tags: ["infra"],
        source_transcripts: ["/tmp/two.md"],
        generated_at: "2026-03-01T00:00:00Z",
        quality: { critic_pass: true, quotes_verified: true },
      }),
    );
    // Malformed artifact — must warn, not throw.
    const badDir = join(dir, "article", "broken");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "artifact.json"), "{not json");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("indexes headlines, tags, quotes, sources, notes — oldest first", async () => {
    const index = await priorArtifactIndex(dir);
    expect(index.entries).toHaveLength(2);
    expect(index.entries[0]!.headline).toBe("Why the cache melts on deploy");
    const card = index.entries[1]!;
    expect(card.headline).toBe("The bridge round is $100K from closing");
    expect(card.tags).toEqual(["fundraising"]);
    expect(card.quote).toBe("100 grand to close");
    expect(card.source_transcripts).toEqual(["/tmp/one.md"]);
    expect(card.source_quotes).toEqual(["100 grand to close"]);
    expect(card.notes).toContain("[novelty]");
  });

  test("malformed artifact.json becomes a warning, not a throw", async () => {
    const index = await priorArtifactIndex(dir);
    expect(index.warnings).toHaveLength(1);
    expect(index.warnings[0]).toContain("broken");
  });

  test("missing dir returns an empty baseline without throwing", async () => {
    const index = await priorArtifactIndex(join(dir, "does-not-exist"));
    expect(index.entries).toEqual([]);
    expect(index.warnings).toEqual([]);
  });
});

describe("shared per-transcript extractors (index ↔ scan agree)", () => {
  test("extractTranscriptTerms splits entities vs domain terms, filters names", () => {
    const t = parseTranscript(
      `# Sync\n**Date:** 2026-06-08\n\n## Transcript\n\n` +
        `**Ada Lovelace:**\nWe ship OpenKey permissioning before the Flashbots rollout.\n\n` +
        `**Grace Hopper:**\nThe permissioning model needs another rollout review.\n`,
      "/tmp/sync.md",
    );
    const { entities, terms } = extractTranscriptTerms(t);
    // Capitalized multi-token/mid-sentence entities surface as entities.
    expect(entities.some((e) => e === "OpenKey" || e === "Flashbots")).toBe(true);
    // Lowercase domain words surface as terms (stopword-filtered).
    expect(terms).toContain("permissioning");
    expect(terms).toContain("rollout");
    // Speaker names never leak into entities/terms.
    const flat = [...entities, ...terms].map((s) => s.toLowerCase());
    expect(flat).not.toContain("ada");
    expect(flat).not.toContain("grace");
  });

  test("empty transcript yields no entities/terms/quantities via the caller", () => {
    const t = parseTranscript(
      `# 2026-06-07 15:05:32\n**Date:** 2026-06-07\n\n## Transcript\n\n_(No transcript segments available.)_\n`,
      "/tmp/empty.md",
    );
    // extractTranscriptTerms over zero spoken turns is empty.
    const { entities, terms } = extractTranscriptTerms(t);
    expect(entities).toEqual([]);
    expect(terms).toEqual([]);
    expect(collectQuantityMentions(t)).toEqual([]);
  });

  test("collectQuantityMentions carries kind/value/context/provenance", () => {
    const t = parseTranscript(
      `# Money\n**Date:** 2026-06-08\n\n## Transcript\n\n` +
        `**Ada (12:56):**\nWe close the round at $100k by Friday, that's 20% done.\n`,
      "/tmp/money.md",
    );
    const ms = collectQuantityMentions(t);
    const money = ms.find((m) => m.kind === "money");
    expect(money?.value).toContain("$100k");
    expect(money?.speaker).toBe("Ada");
    expect(money?.timestamp).toBe("12:56");
    expect(money?.context.length).toBeGreaterThan(0);
    expect(ms.some((m) => m.kind === "percent")).toBe(true);
    expect(ms.some((m) => m.kind === "deadline")).toBe(true);
  });
});
