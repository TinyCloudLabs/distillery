import { describe, expect, test } from "bun:test";
import { scoreNarrativeSeeds } from "../skills/_shared/lib/novelty.ts";
import { parseTranscript } from "../skills/_shared/lib/transcript.ts";

// Synthetic fixtures only — never real meeting content. The narrative-seed
// scorer is the material-format-matching lever: a podcast needs a sustained
// through-line across meetings (a real before→after), a higher bar than a
// card's single insight. These tests prove (a) a set with a drifting quantity
// scores ABOVE a flat set, (b) the chronological evidence chain is ordered
// correctly, and (c) a seed confined to one meeting (a card) never surfaces.

// ---------------------------------------------------------------------------
// A drifting quantity across two meetings = an inherent arc.
// ---------------------------------------------------------------------------

const DRIFT_ONE = `# Sync One
**Date:** 2026-03-01

## Transcript

**Ada Lovelace (00:05:00):**
The bridge round needs $100k to close before the accelerator demo day.

**Grace Hopper:**
Right, I hear you on the bridge round timeline.
`;

const DRIFT_TWO = `# Sync Two
**Date:** 2026-03-15

## Transcript

**Ada Lovelace (00:02:00):**
We only need 50 grand now to close the bridge round, half of before.

**Grace Hopper:**
Good progress on the bridge round then.
`;

// A flat set: the SAME quantity, identical, repeated — a recurring fact, not
// an arc. (Same topic, same value, no movement.)
const FLAT_ONE = `# Flat One
**Date:** 2026-04-01

## Transcript

**Ada Lovelace (00:01:00):**
We have $100k in the bridge round account and the plan looks fine.

**Grace Hopper:**
Sounds good, nothing changed on the bridge round.
`;

const FLAT_TWO = `# Flat Two
**Date:** 2026-04-08

## Transcript

**Ada Lovelace (00:01:00):**
Still $100k in the bridge round account, unchanged from before.

**Grace Hopper:**
Yep, the bridge round is steady.
`;

describe("scoreNarrativeSeeds — drift beats flat (material-format matching)", () => {
  const driftSeeds = scoreNarrativeSeeds(
    [parseTranscript(DRIFT_TWO, "/tmp/d-two.md"), parseTranscript(DRIFT_ONE, "/tmp/d-one.md")],
    { minSpanMeetings: 2 },
  );
  const flatSeeds = scoreNarrativeSeeds(
    [parseTranscript(FLAT_TWO, "/tmp/f-two.md"), parseTranscript(FLAT_ONE, "/tmp/f-one.md")],
    { minSpanMeetings: 2 },
  );

  test("a set with a drifting quantity surfaces a quantified-drift seed", () => {
    const drift = driftSeeds.find((s) => s.kind === "quantified-drift");
    expect(drift).toBeDefined();
    expect(drift!.transcripts).toEqual(["/tmp/d-one.md", "/tmp/d-two.md"]);
    expect(drift!.development).toBeGreaterThan(0.5);
    expect(drift!.rationale).toContain("$100k");
    expect(drift!.rationale).toContain("50 grand");
  });

  test("an identical-value flat set produces no drift seed (recurring fact, not arc)", () => {
    expect(flatSeeds.find((s) => s.kind === "quantified-drift")).toBeUndefined();
  });

  test("the drifting set's top seed outscores the flat set's top seed", () => {
    const driftTop = driftSeeds[0]?.score ?? 0;
    const flatTop = flatSeeds[0]?.score ?? 0;
    expect(driftTop).toBeGreaterThan(flatTop);
  });
});

// ---------------------------------------------------------------------------
// The chronological evidence chain is ordered correctly (before → after),
// regardless of input order.
// ---------------------------------------------------------------------------

describe("scoreNarrativeSeeds — evidence chain ordered chronologically", () => {
  // Inputs deliberately out of date order; the chain must still be oldest-first.
  const seeds = scoreNarrativeSeeds(
    [parseTranscript(DRIFT_TWO, "/tmp/two.md"), parseTranscript(DRIFT_ONE, "/tmp/one.md")],
    { minSpanMeetings: 2 },
  );
  const drift = seeds.find((s) => s.kind === "quantified-drift")!;

  test("evidence is oldest-first with full provenance", () => {
    expect(drift.evidence).toHaveLength(2);
    const [first, second] = drift.evidence;
    expect(first!.date).toBe("2026-03-01");
    expect(second!.date).toBe("2026-03-15");
    expect(first!.value).toBe("$100k");
    expect(second!.value).toBe("50 grand");
    expect(first!.speaker).toBe("Ada Lovelace");
    expect(first!.timestamp).toBe("00:05:00");
    expect(first!.turnIndex).toBe(0);
    expect(first!.context).toContain("$100k");
  });

  test("endpoints differ → rationale records the before→after", () => {
    expect(drift.rationale).toContain('first "$100k" → last "50 grand"');
  });
});

// ---------------------------------------------------------------------------
// A single-meeting insight is a CARD, not an episode lead — never a seed.
// ---------------------------------------------------------------------------

const SINGLE_MEETING = `# Lone Sync
**Date:** 2026-05-01

## Transcript

**Ada Lovelace (00:01:00):**
We are killing seat-based pricing because power users were getting punished.

**Grace Hopper:**
Agreed, flat-rate is the move and churn should drop 20% in the analytics cohort.
`;

describe("scoreNarrativeSeeds — one meeting is a card, never a lead", () => {
  test("a single transcript yields zero seeds (no across-meeting development)", () => {
    const seeds = scoreNarrativeSeeds([parseTranscript(SINGLE_MEETING, "/tmp/lone.md")], {
      minSpanMeetings: 2,
    });
    expect(seeds).toEqual([]);
  });

  test("every seed spans 2+ meetings by construction", () => {
    const seeds = scoreNarrativeSeeds(
      [parseTranscript(DRIFT_ONE, "/tmp/one.md"), parseTranscript(DRIFT_TWO, "/tmp/two.md")],
      { minSpanMeetings: 2 },
    );
    expect(seeds.length).toBeGreaterThan(0);
    for (const s of seeds) {
      expect(s.transcripts.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Single-voice arc + cross-meeting topic spanning 3+ meetings.
// ---------------------------------------------------------------------------

// Ada alone ever says "Quicksilver" (Grace never uses the word) across three
// meetings — a single-voice topic. The room's ENGAGEMENT shifts: ignored early
// (back-channel only), engaged substantively by the last meeting → stance
// development, a real before→after.
// "Permissioning" recurs across three meetings but CHANGES HANDS: Ada raises it
// first early, Grace raises it first later → voice spread, a real cross-meeting
// shift (the thread moved between voices, not one person repeating it).
const ARC_ONE = `# Arc One
**Date:** 2026-03-01

## Transcript

**Ada Lovelace (00:01:00):**
The Quicksilver retry semantics block us, and permissioning is still unresolved.

**Grace Hopper:**
Sure.
`;

const ARC_TWO = `# Arc Two
**Date:** 2026-03-08

## Transcript

**Grace Hopper (00:00:30):**
On permissioning, I built out the first model pass and it is looking workable now after the rework.

**Ada Lovelace (00:01:00):**
Quicksilver dedupe is half-done this week, still grinding on it.
`;

const ARC_THREE = `# Arc Three
**Date:** 2026-03-15

## Transcript

**Grace Hopper (00:00:30):**
Permissioning is basically done now and the rollout can proceed this sprint.

**Ada Lovelace (00:01:00):**
Quicksilver finally shipped after the long retry rework, a real milestone for us.

**Grace Hopper (00:02:00):**
That retry rework is exactly what unblocked our throughput numbers across the board.
`;

describe("scoreNarrativeSeeds — single-voice arc + cross-meeting topic over 3 meetings", () => {
  const seeds = scoreNarrativeSeeds(
    [
      parseTranscript(ARC_ONE, "/tmp/a1.md"),
      parseTranscript(ARC_TWO, "/tmp/a2.md"),
      parseTranscript(ARC_THREE, "/tmp/a3.md"),
    ],
    { minSpanMeetings: 3 },
  );

  test("Quicksilver (only Ada) surfaces as a developed single-voice-arc", () => {
    const sv = seeds.find(
      (s) => s.kind === "single-voice-arc" && /quicksilver/i.test(s.label),
    );
    expect(sv).toBeDefined();
    expect(sv!.transcripts).toEqual(["/tmp/a1.md", "/tmp/a2.md", "/tmp/a3.md"]);
    // Engagement shifts (ignored → engaged) → real development, scored > 0.
    expect(sv!.development).toBeGreaterThan(0);
    expect(sv!.rationale).toContain("stance development");
    // Evidence chain chronological.
    expect(sv!.evidence.map((e) => e.date)).toEqual([
      "2026-03-01",
      "2026-03-08",
      "2026-03-15",
    ]);
  });

  test("permissioning surfaces as a developed cross-meeting-topic (voice spread)", () => {
    const cm = seeds.find(
      (s) => s.kind === "cross-meeting-topic" && /permissioning/i.test(s.label),
    );
    expect(cm).toBeDefined();
    expect(cm!.transcripts.length).toBeGreaterThanOrEqual(2);
    // Carried by a changing set of voices (Ada → Grace) → real development.
    expect(cm!.development).toBeGreaterThan(0);
    expect(cm!.rationale).toMatch(/spread|re-entered/);
  });

  test("a topic confined to fewer than min-span meetings is dropped", () => {
    // minSpan 4 cannot be met by a 3-meeting corpus → no topic-arc seeds.
    const stricter = scoreNarrativeSeeds(
      [
        parseTranscript(ARC_ONE, "/tmp/a1.md"),
        parseTranscript(ARC_TWO, "/tmp/a2.md"),
        parseTranscript(ARC_THREE, "/tmp/a3.md"),
      ],
      { minSpanMeetings: 4 },
    );
    expect(stricter.find((s) => s.kind === "single-voice-arc")).toBeUndefined();
    expect(stricter.find((s) => s.kind === "cross-meeting-topic")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Flat recurrence is NOT development: a topic that merely repeats identically
// across 3 meetings — same speakers, every meeting, no engagement/stance shift —
// must NOT surface as a high-scored "arc". It is floored at development 0 and
// labeled "recurrence only", sorting below every real arc. (The reviewer
// reproduced flat sets scoring 0.38–0.44 with rationales reading "engagement
// flat"/"sustained thread"; this guards against that regression.)
// ---------------------------------------------------------------------------

const FLAT_RECUR = (n: string, d: string) => `# ${n}
**Date:** ${d}

## Transcript

**Ada Lovelace (00:01:00):**
The roadmap planning continues this week as planned.

**Grace Hopper:**
The roadmap planning continues this week as planned.
`;

describe("scoreNarrativeSeeds — flat recurrence is not an arc", () => {
  const flatSeeds = scoreNarrativeSeeds(
    [
      parseTranscript(FLAT_RECUR("Flat A", "2026-04-01"), "/tmp/fr1.md"),
      parseTranscript(FLAT_RECUR("Flat B", "2026-04-08"), "/tmp/fr2.md"),
      parseTranscript(FLAT_RECUR("Flat C", "2026-04-15"), "/tmp/fr3.md"),
    ],
    { minSpanMeetings: 3 },
  );

  test("no flat-recurrence seed scores above zero", () => {
    for (const s of flatSeeds) {
      expect(s.development).toBe(0);
      expect(s.score).toBe(0);
    }
  });

  test("flat-recurrence seeds are labeled 'recurrence only', never 'arc'", () => {
    for (const s of flatSeeds) {
      expect(s.rationale).toContain("recurrence only");
      expect(s.rationale).not.toMatch(/stance development|spread|re-entered/);
    }
  });

  test("a developed arc outranks flat recurrence", () => {
    const developed = scoreNarrativeSeeds(
      [
        parseTranscript(ARC_ONE, "/tmp/a1.md"),
        parseTranscript(ARC_TWO, "/tmp/a2.md"),
        parseTranscript(ARC_THREE, "/tmp/a3.md"),
      ],
      { minSpanMeetings: 3 },
    );
    const developedTop = developed[0]?.score ?? 0;
    const flatTop = flatSeeds[0]?.score ?? 0;
    expect(developedTop).toBeGreaterThan(flatTop);
  });
});

// ---------------------------------------------------------------------------
// DigitalOcean-style quantified drift still ranks at the top — the fix tightens
// the topic-arc floors without weakening the drift path the builder celebrated.
// ---------------------------------------------------------------------------

const DO_ONE = `# Infra Sync One
**Date:** 2026-02-01

## Transcript

**Ada Lovelace (00:03:00):**
Our DigitalOcean bill is running about $4,000 a month right now.

**Grace Hopper:**
That DigitalOcean spend is steep — what is the plan to bring it down?
`;

const DO_TWO = `# Infra Sync Two
**Date:** 2026-02-15

## Transcript

**Ada Lovelace (00:03:00):**
We cut the DigitalOcean bill to $1,200 a month after the rightsizing pass.

**Grace Hopper:**
Huge drop on the DigitalOcean cost — nice work on the rightsizing.
`;

describe("scoreNarrativeSeeds — quantified drift still ranks top after the fix", () => {
  const seeds = scoreNarrativeSeeds(
    [parseTranscript(DO_TWO, "/tmp/do2.md"), parseTranscript(DO_ONE, "/tmp/do1.md")],
    { minSpanMeetings: 2 },
  );

  test("the DigitalOcean drift is the top-ranked seed", () => {
    expect(seeds[0]).toBeDefined();
    expect(seeds[0]!.kind).toBe("quantified-drift");
    expect(seeds[0]!.development).toBeGreaterThan(0.5);
  });

  test("drift outscores any topic-arc seed in the same set", () => {
    const drift = seeds.find((s) => s.kind === "quantified-drift")!;
    const topicArcs = seeds.filter((s) => s.kind !== "quantified-drift");
    for (const t of topicArcs) {
      expect(drift.score).toBeGreaterThan(t.score);
    }
  });
});
