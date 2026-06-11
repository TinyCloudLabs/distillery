import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  isFeedbackAction,
  readEvents,
  summarizeEvents,
  FEEDBACK_ACTIONS,
  type FeedbackEvent,
} from "../skills/_shared/lib/feedback.ts";

function ev(overrides: Partial<FeedbackEvent> = {}): FeedbackEvent {
  return {
    artifact_id: "a-1",
    artifact_type: "insight-card",
    action: "more",
    ts: "2026-06-10T12:00:00.000Z",
    ...overrides,
  };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "distillery-feedback-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("isFeedbackAction", () => {
  test("accepts exactly the six actions", () => {
    for (const a of FEEDBACK_ACTIONS) expect(isFeedbackAction(a)).toBe(true);
    expect(FEEDBACK_ACTIONS.length).toBe(6);
    expect(isFeedbackAction("like")).toBe(false);
    expect(isFeedbackAction("")).toBe(false);
    expect(isFeedbackAction(42)).toBe(false);
  });
});

describe("appendEvent / readEvents", () => {
  test("appends JSONL lines, creating parent directories", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "nested", "deeper", "events.jsonl");
      await appendEvent(file, ev());
      await appendEvent(file, ev({ action: "save", note: "keep this" }));

      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      expect(lines.length).toBe(3); // 2 events + trailing empty
      expect(lines[2]).toBe("");

      const events = await readEvents(file);
      expect(events.length).toBe(2);
      expect(events[0]!.action).toBe("more");
      expect(events[1]!.action).toBe("save");
      expect(events[1]!.note).toBe("keep this");
    });
  });

  test("readEvents trims notes, matching the API write path", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "events.jsonl");
      await appendEvent(file, ev({ note: "  padded note  " }));
      await appendEvent(file, ev({ note: "   " })); // whitespace-only → dropped
      const events = await readEvents(file);
      expect(events[0]!.note).toBe("padded note");
      expect(events[1]!.note).toBeUndefined();
    });
  });

  test("appendEvent rejects an out-of-enum action", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "events.jsonl");
      await expect(
        appendEvent(file, { ...ev(), action: "meh" as never }),
      ).rejects.toThrow(/invalid action/);
    });
  });

  test("appendEvent mirrors read-side validation — nothing unreadable is persisted", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "events.jsonl");
      const bad: Array<[Partial<Record<keyof FeedbackEvent, unknown>>, RegExp]> = [
        [{ artifact_id: "" }, /artifact_id/],
        [{ artifact_id: "   " }, /artifact_id/],
        [{ artifact_id: undefined }, /artifact_id/],
        [{ artifact_id: 42 }, /artifact_id/],
        [{ artifact_type: undefined }, /artifact_type/],
        [{ artifact_type: 7 }, /artifact_type/],
        [{ ts: "" }, /ts/],
        [{ ts: "  " }, /ts/],
        [{ ts: undefined }, /ts/],
        [{ note: 42 }, /note/],
      ];
      for (const [overrides, msg] of bad) {
        await expect(
          appendEvent(file, { ...ev(), ...overrides } as FeedbackEvent),
        ).rejects.toThrow(msg);
      }
      // none of the rejected events touched the log (file never created)
      expect(await readEvents(file)).toEqual([]);

      // anything appendEvent accepts, readEvents returns
      await appendEvent(file, ev({ artifact_type: "" })); // empty type is read-valid
      expect((await readEvents(file)).length).toBe(1);
    });
  });

  test("readEvents on a missing file returns []", async () => {
    await withTmp(async (dir) => {
      expect(await readEvents(join(dir, "nope.jsonl"))).toEqual([]);
    });
  });

  test("tolerates a trailing partial line from an interrupted write", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "events.jsonl");
      await appendEvent(file, ev());
      await appendFile(file, '{"artifact_id":"a-2","artifact_type":"pod', "utf8");

      const events = await readEvents(file);
      expect(events.length).toBe(1);
      expect(events[0]!.artifact_id).toBe("a-1");
    });
  });

  test("skips malformed and shape-invalid lines anywhere in the file", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "events.jsonl");
      await appendFile(
        file,
        [
          "not json at all",
          JSON.stringify(ev({ artifact_id: "good-1" })),
          JSON.stringify({ artifact_id: "bad", artifact_type: "x", action: "like", ts: "t" }),
          JSON.stringify({ artifact_type: "x", action: "more", ts: "t" }), // no id
          "[1,2,3]",
          "",
          JSON.stringify(ev({ artifact_id: "good-2", action: "wrong" })),
        ].join("\n") + "\n",
        "utf8",
      );

      const events = await readEvents(file);
      expect(events.map((e) => e.artifact_id)).toEqual(["good-1", "good-2"]);
    });
  });
});

describe("summarizeEvents", () => {
  const events: FeedbackEvent[] = [
    ev({ artifact_id: "a-1", action: "more" }),
    ev({ artifact_id: "a-1", action: "more", ts: "2026-06-11T09:00:00.000Z" }),
    ev({ artifact_id: "a-1", action: "save", note: "useful", ts: "2026-06-11T10:00:00.000Z" }),
    ev({ artifact_id: "a-2", artifact_type: "podcast", action: "less", note: "too internal" }),
    ev({ artifact_id: "a-2", artifact_type: "podcast", action: "less" }),
    ev({ artifact_id: "a-3", artifact_type: "article", action: "promote" }),
  ];

  test("counts per action and per artifact, tracking notes and last_ts", () => {
    const s = summarizeEvents(events);
    expect(s.total_events).toBe(6);
    expect(s.by_action).toEqual({
      more: 2,
      less: 2,
      save: 1,
      already_knew: 0,
      wrong: 0,
      promote: 1,
    });

    expect(s.by_artifact.map((r) => r.artifact_id)).toEqual(["a-1", "a-2", "a-3"]);
    const a1 = s.by_artifact[0]!;
    expect(a1.actions.more).toBe(2);
    expect(a1.actions.save).toBe(1);
    expect(a1.total).toBe(3);
    expect(a1.last_ts).toBe("2026-06-11T10:00:00.000Z");
    expect(a1.notes).toEqual([
      { action: "save", note: "useful", ts: "2026-06-11T10:00:00.000Z" },
    ]);

    const a2 = s.by_artifact[1]!;
    expect(a2.actions.less).toBe(2);
    expect(a2.notes[0]!.note).toBe("too internal");
  });

  test("aggregates per type even without an artifact join", () => {
    const s = summarizeEvents(events);
    expect(s.by_type.map((r) => [r.key, r.total, r.artifacts])).toEqual([
      ["insight-card", 3, 1],
      ["podcast", 2, 1],
      ["article", 1, 1],
    ]);
    expect(s.by_tag).toEqual([]); // no artifacts provided → no tag join
  });

  test("joins artifacts for tags, headlines, and authoritative type", () => {
    const s = summarizeEvents(events, [
      { id: "a-1", type: "insight-card", tags: ["sparq", "pricing"], headline: "One" },
      { id: "a-2", type: "podcast", tags: ["sparq"], headline: "Two" },
      // a-3 not in the join — event-carried type survives
    ]);

    expect(s.by_artifact[0]!.headline).toBe("One");
    expect(s.by_artifact[0]!.tags).toEqual(["sparq", "pricing"]);

    const sparq = s.by_tag.find((r) => r.key === "sparq")!;
    expect(sparq.total).toBe(5);
    expect(sparq.artifacts).toBe(2);
    expect(sparq.actions.less).toBe(2);
    const pricing = s.by_tag.find((r) => r.key === "pricing")!;
    expect(pricing.total).toBe(3);
    expect(pricing.artifacts).toBe(1);

    expect(s.by_type.find((r) => r.key === "article")!.total).toBe(1);
  });

  test("last_ts compares instants, not strings, across mixed ISO forms", () => {
    const s = summarizeEvents([
      // lexically "…30Z" > "…00.000Z" would be wrong here: the offset form
      // below is the later instant.
      ev({ ts: "2026-06-11T09:00:30Z" }),
      ev({ ts: "2026-06-11T11:00:00.000+01:00" }), // = 10:00:00Z
    ]);
    expect(s.by_artifact[0]!.last_ts).toBe("2026-06-11T11:00:00.000+01:00");
  });

  test("empty input produces an empty, well-shaped summary", () => {
    const s = summarizeEvents([]);
    expect(s.total_events).toBe(0);
    expect(s.by_artifact).toEqual([]);
    expect(s.by_tag).toEqual([]);
    expect(s.by_type).toEqual([]);
    expect(Object.values(s.by_action).every((n) => n === 0)).toBe(true);
  });
});
