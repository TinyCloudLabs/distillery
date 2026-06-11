import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FEEDBACK_ACTIONS as CANONICAL_ACTIONS,
  type FeedbackSummary,
} from "../../skills/_shared/lib/feedback.ts";
import { FEEDBACK_ACTIONS as MIRRORED_ACTIONS } from "../src/types.ts";
import { createApp } from "../src/app.ts";
import { makeFixture, type Fixture } from "./fixtures.ts";

let fx: Fixture;
let stateDir: string;
let feedbackFile: string;
let app: ReturnType<typeof createApp>;

async function post(body: unknown): Promise<Response> {
  return await app.request("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  fx = await makeFixture();
  stateDir = await mkdtemp(join(tmpdir(), "distillery-feedback-api-"));
  // deliberately in a not-yet-existing subdir — appendEvent must create it
  feedbackFile = join(stateDir, "feedback", "events.jsonl");
  app = createApp({ artifactsDir: fx.dir, feedbackFile });
});

afterAll(async () => {
  await fx.cleanup();
  await rm(stateDir, { recursive: true, force: true });
});

// Drift guard: feed/src/types.ts mirrors the canonical action union from
// skills/_shared/lib/feedback.ts (the browser bundle can't import node:fs).
// Tests run under bun, so they can import both — fail loudly on divergence
// instead of surfacing as buttons whose POSTs 400.
test("FEEDBACK_ACTIONS mirror matches canonical", () => {
  expect([...MIRRORED_ACTIONS]).toEqual([...CANONICAL_ACTIONS]);
});

describe("POST /api/feedback", () => {
  test("valid action appends one JSONL line with server ts and disk-authoritative type", async () => {
    const res = await post({ artifact_id: "pod-1", action: "more" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; event: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.event.artifact_type).toBe("podcast");

    const lines = (await readFile(feedbackFile, "utf8")).trim().split("\n");
    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(event.artifact_id).toBe("pod-1");
    expect(event.artifact_type).toBe("podcast");
    expect(event.action).toBe("more");
    expect(Number.isNaN(Date.parse(event.ts as string))).toBe(false);
    expect(event.note).toBeUndefined();
  });

  test("carries an optional note (trimmed)", async () => {
    const res = await post({ artifact_id: "ins-1", action: "less", note: "  too internal  " });
    expect(res.status).toBe(201);
    const lines = (await readFile(feedbackFile, "utf8")).trim().split("\n");
    const event = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(event.action).toBe("less");
    expect(event.note).toBe("too internal");
  });

  test("400s on an action outside the six-value enum", async () => {
    const res = await post({ artifact_id: "pod-1", action: "like" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("action");
  });

  test("400s on garbage payloads", async () => {
    expect((await post({ action: "more" })).status).toBe(400); // no artifact_id
    expect((await post({ artifact_id: "", action: "more" })).status).toBe(400);
    expect((await post({ artifact_id: "pod-1", action: "more", note: 42 })).status).toBe(400);
    expect((await post([1, 2, 3])).status).toBe(400);
    const notJson = await app.request("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ nope",
    });
    expect(notJson.status).toBe(400);
  });

  test("404s when the artifact does not exist", async () => {
    const res = await post({ artifact_id: "ghost-99", action: "save" });
    expect(res.status).toBe(404);
  });

  test("rejected requests append nothing", async () => {
    const before = (await readFile(feedbackFile, "utf8")).trim().split("\n").length;
    await post({ artifact_id: "pod-1", action: "like" });
    await post({ artifact_id: "ghost-99", action: "save" });
    const after = (await readFile(feedbackFile, "utf8")).trim().split("\n").length;
    expect(after).toBe(before);
  });
});

describe("GET /api/feedback/summary", () => {
  test("returns aggregates joined with current cards", async () => {
    await post({ artifact_id: "pod-1", action: "promote" });

    const res = await app.request("/api/feedback/summary");
    expect(res.status).toBe(200);
    const s = (await res.json()) as FeedbackSummary;

    expect(s.total_events).toBe(3); // more + less + promote from the tests above
    expect(s.by_action.more).toBe(1);
    expect(s.by_action.less).toBe(1);
    expect(s.by_action.promote).toBe(1);

    const pod = s.by_artifact.find((r) => r.artifact_id === "pod-1")!;
    expect(pod.headline).toBe("Newest podcast"); // joined from the card
    expect(pod.tags).toEqual(["audio", "weekly"]);
    expect(pod.actions.promote).toBe(1);

    const audioTag = s.by_tag.find((r) => r.key === "audio")!;
    expect(audioTag.total).toBe(2);
    expect(s.by_type.find((r) => r.key === "insight-card")!.actions.less).toBe(1);
  });
});
