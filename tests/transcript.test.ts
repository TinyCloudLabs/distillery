import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  chunkTranscript,
  loadTranscripts,
  parseTranscript,
  transcriptDuration,
  verifyQuote,
} from "../skills/_shared/lib/transcript.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const CORPUS = join(FIXTURES, "corpus");
const SOUNDCORE = join(FIXTURES, "soundcore");

describe("parseTranscript — fireflies/gemini-sync style", () => {
  async function parsed() {
    const path = join(CORPUS, "fireflies-style.md");
    return parseTranscript(await readFile(path, "utf8"), path);
  }

  test("extracts header metadata", async () => {
    const t = await parsed();
    expect(t.title).toBe("Widget Co Weekly Sync");
    expect(t.date).toBe("2026-01-15");
    expect(t.duration).toBe("30 min");
    expect(t.participants).toEqual(["ada@example.com", "grace@example.com"]);
  });

  test("captures summary and action items sections", async () => {
    const t = await parsed();
    expect(t.summary).toContain("usage-based pricing");
    expect(t.actionItems).toContain("Draft the usage-based pricing experiment doc");
  });

  test("parses speaker turns with multi-paragraph bodies and timestamps", async () => {
    const t = await parsed();
    expect(t.turns).toHaveLength(3);
    expect(t.turns[0]?.speaker).toBe("Ada Lovelace");
    expect(t.turns[0]?.text).toContain("charge by the widget");
    expect(t.turns[0]?.text).toContain("Seats punish our best users.");
    expect(t.turns[1]?.speaker).toBe("Grace Hopper");
    expect(t.turns[1]?.timestamp).toBe("00:12:30");
  });

  test("action-item bold names are not misread as turns", async () => {
    const t = await parsed();
    expect(t.turns.every((turn) => !turn.text.includes("job board"))).toBe(true);
  });
});

describe("parseTranscript — yaml frontmatter style", () => {
  test("reads frontmatter and turns", async () => {
    const path = join(CORPUS, "frontmatter-style.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(t.title).toBe("Roadmap Brainstorm");
    expect(t.date).toBe("2026-02-02");
    expect(t.source).toBe("voxterm");
    expect(t.turns).toHaveLength(2);
    expect(t.turns[1]?.speaker).toBe("Grace");
    expect(t.turns[1]?.text).toContain("time-to-value");
  });
});

describe("parseTranscript — bare diarized + plain fallback", () => {
  test("parses 'Name: text' lines", async () => {
    const path = join(CORPUS, "bare-diarized.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(t.turns).toHaveLength(3);
    expect(t.turns[0]?.speaker).toBe("Ada");
    expect(t.turns[2]?.text).toContain("version the cache keys");
  });

  test("plain text becomes a single unattributed turn", async () => {
    const path = join(FIXTURES, "plain.txt");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.speaker).toBeUndefined();
    expect(t.turns[0]?.text).toContain("no speakers at all");
  });
});

describe("parseTranscript — prose-with-colon regression", () => {
  test("prose line containing a colon stays attached to the preceding speaker", () => {
    const raw = [
      "Ada: The cache invalidation bug only shows up on the second deploy.",
      "Same root cause: deploys flush the cache.",
      "Grace: Because the first deploy warms the cache with stale keys.",
    ].join("\n");
    const t = parseTranscript(raw);
    expect(t.turns).toHaveLength(2);
    expect(t.turns[0]?.speaker).toBe("Ada");
    expect(t.turns[0]?.text).toContain("Same root cause: deploys flush the cache.");
    expect(t.turns.map((turn) => turn.speaker)).not.toContain("Same root cause");
  });

  test("lowercase and over-long colon labels never start turns", () => {
    const raw = [
      "Ada: Here's the plan.",
      "first thing tomorrow: revert the deploy.",
      "The Next Step For Us All: rotate on-call.",
    ].join("\n");
    const t = parseTranscript(raw);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.speaker).toBe("Ada");
    expect(t.turns[0]?.text).toContain("rotate on-call.");
  });

  test("name-like colon lines inside a bold-format file are body text, not turns", () => {
    const raw = [
      "## Transcript",
      "",
      "**Ada Lovelace:**",
      "Two options on the table.",
      "Plan B: we ship Friday.",
      "",
      "**Grace Hopper:**",
      "Friday works.",
    ].join("\n");
    const t = parseTranscript(raw);
    expect(t.turns).toHaveLength(2);
    expect(t.turns[0]?.speaker).toBe("Ada Lovelace");
    expect(t.turns[0]?.text).toContain("Plan B: we ship Friday.");
  });

  test("real diarization name shapes still parse as turns", () => {
    const raw = [
      "[00:12] Grace Hopper: Timestamped turn.",
      "O'Brien: Apostrophe surname.",
      "Mary-Jane Watson: Hyphenated first name.",
      "Speaker 2: Numbered diarizer label.",
      "Ada Augusta King: Three-word name.",
    ].join("\n");
    const t = parseTranscript(raw);
    expect(t.turns.map((turn) => turn.speaker)).toEqual([
      "Grace Hopper",
      "O'Brien",
      "Mary-Jane Watson",
      "Speaker 2",
      "Ada Augusta King",
    ]);
    expect(t.turns[0]?.timestamp).toBe("00:12");
  });
});

describe("parseTranscript — Soundcore adapter (spec §4)", () => {
  async function read(name: string) {
    const path = join(SOUNDCORE, name);
    return { path, raw: await readFile(path, "utf8") };
  }

  test("block-form turns parse, scoped to the post-## Transcript region", async () => {
    const { path, raw } = await read("soundcore-with-turns.md");
    const t = parseTranscript(raw, path);
    expect(t.title).toBe("Synthetic Soundcore Planning Meeting");
    expect(t.date).toBe("2026-06-08");
    expect(t.duration).toBe("23 min");
    // Exactly the four real turns under ## Transcript — nothing from the WH
    // summary above it.
    expect(t.turns).toHaveLength(4);
    expect(t.turns.map((turn) => turn.speaker)).toEqual([
      "Ada",
      "Grace",
      "speaker1",
      "speaker2",
    ]);
    // Block-form: label alone, text on the next line.
    expect(t.turns[0]?.text).toContain("charge by the widget");
    expect(t.turns[1]?.text).toContain("Usage-based pricing aligns revenue");
    // A "Plan B:" colon line inside a turn stays body, not a phantom speaker.
    expect(t.turns[2]?.text).toContain("Plan B: we ship the pricing change Friday.");
  });

  test("WH-summary prose never becomes a speaker turn", async () => {
    const { path, raw } = await read("soundcore-with-turns.md");
    const t = parseTranscript(raw, path);
    const speakers = t.turns.map((turn) => turn.speaker);
    for (const phantom of [
      "What",
      "Who",
      "Related Personnel",
      "Decision status",
      "Priority order",
      "Open question",
      "Decision / alignment",
      "Time",
    ]) {
      expect(speakers).not.toContain(phantom);
    }
    // The WH prose is routed into summary, not lost.
    expect(t.summary).toContain("Widget Pricing Direction");
  });

  test("metadata header is never read as a speaker turn", async () => {
    const { path, raw } = await read("soundcore-with-turns.md");
    const t = parseTranscript(raw, path);
    const speakers = t.turns.map((turn) => turn.speaker);
    expect(speakers).not.toContain("Date");
    expect(speakers).not.toContain("Duration");
    // No turn text carries the header metadata.
    expect(t.turns.every((turn) => !turn.text.includes("**Date:**"))).toBe(true);
  });

  test("empty 'no segments' file yields ZERO turns + empty=true (bug 1)", async () => {
    const { path, raw } = await read("soundcore-empty.md");
    const t = parseTranscript(raw, path);
    expect(t.empty).toBe(true);
    expect(t.turns).toHaveLength(0);
    // Title/date still lifted for the index.
    expect(t.title).toBe("2026-06-07 15:05:32");
    expect(t.date).toBe("2026-06-07");
    // No garbage turn swallowing the metadata + placeholder.
    expect(t.turns.length).toBe(0);
    // An empty transcript never verifies a quote against its metadata-only raw.
    expect(verifyQuote(t, "No transcript segments available")).toBe(false);
    expect(verifyQuote(t, "Date")).toBe(false);
  });

  test("WH-prose-before-transcript trap: deep-section bold lines stay out of turns (bug 2)", async () => {
    const { path, raw } = await read("soundcore-wh-trap.md");
    const t = parseTranscript(raw, path);
    // Only the two real turns under ## Transcript.
    expect(t.turns).toHaveLength(2);
    expect(t.turns.map((turn) => turn.speaker)).toEqual(["Hunter", "speaker1"]);
    const speakers = t.turns.map((turn) => turn.speaker);
    // These bold lines sit in a deep ### subsection — the generic gate
    // ("metadata only before first turn") would NOT protect them.
    for (const phantom of [
      "What",
      "Who",
      "Proposed next steps",
      "Status",
      "Open parameters",
      "Decision / alignment",
    ]) {
      expect(speakers).not.toContain(phantom);
    }
  });

  test("loadTranscripts surfaces empty Soundcore files with empty=true", async () => {
    const all = await loadTranscripts([SOUNDCORE]);
    expect(all).toHaveLength(3);
    const empties = all.filter((t) => t.empty);
    expect(empties).toHaveLength(1);
    expect(empties[0]?.turns).toHaveLength(0);
    // The two real files carry turns and are not flagged empty.
    expect(all.filter((t) => !t.empty).every((t) => t.turns.length > 0)).toBe(true);
  });
});

describe("parseTranscript — Soundcore PR#5 review regressions", () => {
  // A minimal Soundcore-shaped file: WH-summary signature above ## Transcript so
  // isSoundcore() routes it to parseSoundcore.
  const wh = "## Summary\n\n**What**: pricing\n\n## Summary\n\n**What**: pricing again\n";

  test("greedy inline-label guard: mid-turn **Note:** stays in body (one turn)", () => {
    // Block-form **speaker1:** label opens a turn; the FOLLOWING body line
    // starts with bold emphasis **Note:** — it must NOT become a phantom
    // speaker. Reviewer's verified case (transcript.ts:298).
    const raw =
      `# Greedy Trap\n**Date:** 2026-06-09\n\n${wh}\n## Transcript\n\n` +
      `**speaker1:**\n` +
      `We should ship this.\n` +
      `**Note:** the rest of speaker1's thought goes here.\n`;
    const t = parseTranscript(raw);
    // ONE turn, the real speaker, with the Note text retained in the body.
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.speaker).toBe("speaker1");
    expect(t.turns.map((x) => x.speaker)).not.toContain("Note");
    expect(t.turns[0]?.text).toContain("We should ship this.");
    expect(t.turns[0]?.text).toContain("**Note:** the rest of speaker1's thought");
  });

  test("a genuinely speaker-shaped inline label still opens a turn mid-region", () => {
    // Sanity: a distinct speaker label (speaker2 / a multi-token name) is NOT
    // emphasis and should still split turns inline.
    const raw =
      `# Inline Speakers\n**Date:** 2026-06-09\n\n${wh}\n## Transcript\n\n` +
      `**speaker1:** first thing\n` +
      `**speaker2:** second thing\n`;
    const t = parseTranscript(raw);
    expect(t.turns).toHaveLength(2);
    expect(t.turns.map((x) => x.speaker)).toEqual(["speaker1", "speaker2"]);
  });

  test("empty-sentinel does NOT wipe a file that has real turns + the sentinel", () => {
    // A real **Sam:** turn followed by the sentinel string later in the body
    // must parse to turns=1, empty=false (transcript.ts:133). The sentinel only
    // flags empty when it is the SOLE content under ## Transcript.
    const raw =
      `# Sentinel Mixed\n**Date:** 2026-06-09\n\n${wh}\n## Transcript\n\n` +
      `**Sam:**\n` +
      `Here is a real spoken turn.\n` +
      `We once saw _(No transcript segments available.)_ in another export.\n`;
    const t = parseTranscript(raw);
    expect(t.empty).toBeFalsy();
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.speaker).toBe("Sam");
    expect(t.turns[0]?.text).toContain("Here is a real spoken turn.");
  });

  test("empty-sentinel still flags empty when it is the sole content", () => {
    const raw = `# Empty\n**Date:** 2026-06-09\n\n## Transcript\n\n_(No transcript segments available.)_\n`;
    const t = parseTranscript(raw);
    expect(t.empty).toBe(true);
    expect(t.turns).toHaveLength(0);
  });

  test("double ## Transcript heading: turns under the FIRST region are kept", () => {
    // Two ## Transcript headings — splitting on the FINAL one would drop the
    // first region's turns. Splitting on the FIRST keeps both (transcript.ts:267).
    const raw =
      `# Double Heading\n**Date:** 2026-06-09\n\n${wh}\n` +
      `## Transcript\n\n` +
      `**speaker1:**\n` +
      `First region turn.\n\n` +
      `## Transcript\n\n` +
      `**speaker2:**\n` +
      `Second region turn.\n`;
    const t = parseTranscript(raw);
    expect(t.turns).toHaveLength(2);
    expect(t.turns.map((x) => x.speaker)).toEqual(["speaker1", "speaker2"]);
    expect(t.turns[0]?.text).toContain("First region turn.");
    expect(t.turns[1]?.text).toContain("Second region turn.");
  });
});

describe("loadTranscripts", () => {
  test("walks directories recursively, picking only .md/.txt", async () => {
    const all = await loadTranscripts([FIXTURES]);
    // 3 corpus .md + plain.txt + 3 soundcore/*.md
    expect(all.length).toBe(7);
  });

  test("accepts a mix of files and dirs", async () => {
    const all = await loadTranscripts([
      join(FIXTURES, "plain.txt"),
      CORPUS,
    ]);
    expect(all.length).toBe(4);
  });

  test("throws on a missing path", async () => {
    expect(loadTranscripts([join(FIXTURES, "nope.md")])).rejects.toThrow();
  });
});

describe("chunkTranscript", () => {
  test("groups turns under maxChars and tracks speakers", async () => {
    const path = join(CORPUS, "fireflies-style.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    const chunks = chunkTranscript(t, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.transcript).toBe(path);
    expect(chunks[0]?.index).toBe(0);
    expect(chunks.flatMap((c) => c.speakers)).toContain("Grace Hopper");
    // No text lost: all turn text appears across chunks.
    const joined = chunks.map((c) => c.text).join("\n\n");
    for (const turn of t.turns) expect(joined).toContain(turn.text);
  });

  test("one big chunk when under the limit", async () => {
    const path = join(CORPUS, "bare-diarized.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(chunkTranscript(t, 100_000)).toHaveLength(1);
  });
});

describe("transcriptDuration", () => {
  test("computes the span from first/last turn timestamps, overriding a lying header", () => {
    const raw = [
      "# Synthetic Long Meeting",
      "**Date:** 2026-06-10",
      "**Duration:** 0 min", // Fireflies emits this even for hour-long calls
      "",
      "## Transcript",
      "",
      "**Ada Lovelace (00:00:05):**",
      "Kicking off.",
      "",
      "**Grace Hopper (00:31:40):**",
      "Midpoint check.",
      "",
      "**Ada Lovelace (01:02:10):**",
      "Wrapping up.",
    ].join("\n");
    const t = parseTranscript(raw, "long.md");
    expect(t.duration).toBe("0 min"); // header parses as-is...
    expect(transcriptDuration(t)).toBe("62 min"); // ...but the span wins
  });

  test("treats two-part stamps as MM:SS", () => {
    const raw = ["[00:10] Ada: start", "[25:47] Grace: end"].join("\n");
    const t = parseTranscript(raw, "short.md");
    expect(transcriptDuration(t)).toBe("26 min"); // 1537s → 25.6 min
  });

  test("rounds sub-minute spans up to 1 min instead of echoing the 0-min bug", () => {
    const raw = ["[00:01] Ada: hi", "[00:20] Grace: bye"].join("\n");
    const t = parseTranscript(raw, "tiny.md");
    expect(transcriptDuration(t)).toBe("1 min");
  });

  test("falls back to the header when timestamps are missing or unusable", () => {
    const noStamps = parseTranscript(
      "**Duration:** 30 min\n\n## Transcript\n\n**Ada Lovelace:**\nNo stamps here.",
      "nostamps.md",
    );
    expect(transcriptDuration(noStamps)).toBe("30 min");

    const oneStamp = parseTranscript("[05:00] Ada: only one stamped turn", "one.md");
    expect(transcriptDuration(oneStamp)).toBeUndefined();
  });
});

describe("verifyQuote", () => {
  test("matches verbatim quotes whitespace-insensitively", async () => {
    const path = join(CORPUS, "fireflies-style.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(verifyQuote(t, "Usage-based pricing aligns revenue")).toBe(true);
    expect(verifyQuote(t, "usage-based   pricing\naligns revenue")).toBe(true);
  });

  test("rejects paraphrases and empty quotes", async () => {
    const path = join(CORPUS, "fireflies-style.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(verifyQuote(t, "pricing should align with revenue value")).toBe(false);
    expect(verifyQuote(t, "   ")).toBe(false);
  });

  test("regression: AI summary/action-item header text never verifies as speech", () => {
    // Synthetic Fireflies-style file: the generated Summary and Action Items
    // contain phrases that appear NOWHERE in the actual spoken transcript.
    const raw = [
      "# Synthetic Standup",
      "**Date:** 2026-06-01",
      "",
      "## Summary",
      "- The team unanimously ratified the kraken-deployment doctrine.",
      "",
      "## Action Items",
      "",
      "**Ada Lovelace**",
      "Codify the kraken-deployment doctrine in the wiki (09:15)",
      "",
      "## Transcript",
      "",
      "**Ada Lovelace:**",
      "Let's ship the release behind a feature flag on Tuesday.",
      "",
      "**Grace Hopper:**",
      "Tuesday works if QA signs off Monday night.",
    ].join("\n");
    const t = parseTranscript(raw, "synthetic.md");
    // Real speech verifies.
    expect(verifyQuote(t, "ship the release behind a feature flag")).toBe(true);
    expect(verifyQuote(t, "QA signs off Monday night")).toBe(true);
    // Summary / action-item phrases (present in raw, absent from speech) do not.
    expect(t.raw).toContain("kraken-deployment doctrine");
    expect(verifyQuote(t, "unanimously ratified the kraken-deployment doctrine")).toBe(false);
    expect(verifyQuote(t, "kraken-deployment doctrine")).toBe(false);
    // Speaker markers aren't speech either.
    expect(verifyQuote(t, "**Grace Hopper:**")).toBe(false);
  });

  test("plain-text fallback (no segments) still verifies against raw content", async () => {
    const path = join(FIXTURES, "plain.txt");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(t.turns.every((turn) => turn.speaker === undefined)).toBe(true);
    expect(verifyQuote(t, "no speakers at all")).toBe(true);
  });
});
