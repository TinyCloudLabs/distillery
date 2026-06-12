// drafts-api.test.ts — the routing seam + approvals tray (Phase 1a).
//
// Covers the contract:
//   - GET /api/cards EXCLUDES pending outward drafts, INCLUDES approved outward
//     + all internal artifacts.
//   - GET /api/drafts returns ONLY pending outward drafts.
//   - POST /api/drafts/:id/approve flips approval_status on disk; the item then
//     appears in /api/cards and leaves /api/drafts.
//   - POST /api/drafts/:id/kill quarantines + drops it from both surfaces.
//   - POST /api/drafts/:id/expand records a `promote` event; the draft stays.
//   - Path-traversal on :id is blocked (400, no fs touch).
//   - Every route is GATED (unauth → 401).

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import type { CardsResponse, FeedCard } from "../src/types.ts";
import { SESSION_COOKIE_NAME } from "../src/session.ts";
import { readEvents } from "../../../skills/_shared/lib/feedback.ts";
import { makeFixture, type Fixture } from "./fixtures.ts";

const ALLOWED = "0x6Ac0836fF53107F990233688A95CF44f58bBbFD6";

let fx: Fixture;
let stateDir: string;
let feedbackFile: string;
let sessionsDbPath: string;

type DraftsResponse = { drafts: FeedCard[]; total: number };

beforeEach(async () => {
  fx = await makeFixture();
  stateDir = await mkdtemp(join(tmpdir(), "distillery-drafts-"));
  feedbackFile = join(stateDir, "feedback", "events.jsonl");
  sessionsDbPath = join(stateDir, "sessions.db");
});

afterEach(async () => {
  await fx.cleanup();
  await rm(stateDir, { recursive: true, force: true });
});

/** App with auth DISABLED — for asserting the route behavior itself. */
function openApp() {
  return createApp({ artifactsDir: fx.dir, feedbackFile, auth: { disabled: true } });
}

/** App with auth ENABLED — for asserting the gate (401). */
function gatedApp() {
  return createApp({
    artifactsDir: fx.dir,
    feedbackFile,
    auth: { sessionsDbPath, allowedAddresses: [ALLOWED], disabled: false },
  });
}

describe("routing seam — GET /api/cards", () => {
  test("excludes pending outward drafts, includes approved outward + internal", async () => {
    const app = openApp();
    const res = await app.request("/api/cards");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CardsResponse;
    const ids = body.cards.map((c) => c.id);

    // approved outward + every internal type publish…
    expect(ids).toContain("approved-snippet-1");
    expect(ids).toContain("pod-1");
    expect(ids).toContain("ins-1");
    expect(ids).toContain("art-1");
    expect(ids).toContain("unk-1");
    // …the pending outward draft does NOT.
    expect(ids).not.toContain("draft-pending-1");
    // CARDINAL CHECK: an outward type with a MISSING or BLANK approval_status
    // defaults to pending and must NEVER reach the published feed.
    expect(ids).not.toContain("draft-missing-status-1");
    expect(ids).not.toContain("draft-blank-status-1");
  });

  // THE CARDINAL CHECK, isolated: no outward draft may publish without an
  // explicit approval_status === "approved". We assert the exhaustive published
  // set so a future regression that leaks ANY outward-pending artifact fails loudly.
  test("published feed is EXACTLY the internal + approved-outward set — no draft leaks", async () => {
    const app = openApp();
    const body = (await (await app.request("/api/cards")).json()) as CardsResponse;
    const ids = body.cards.map((c) => c.id).sort();
    expect(ids).toEqual([
      "approved-snippet-1",
      "art-1",
      "ins-1",
      "pod-1",
      "unk-1",
    ]);
  });

  test("single-card route 404s a pending draft", async () => {
    const app = openApp();
    const res = await app.request("/api/cards/social-post/pending-banger");
    expect(res.status).toBe(404);
  });

  test("single-card route serves an approved outward artifact", async () => {
    const app = openApp();
    const res = await app.request(
      "/api/cards/investor-update-snippet/approved-snippet",
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as FeedCard).id).toBe("approved-snippet-1");
  });
});

describe("GET /api/drafts", () => {
  test("returns only pending outward drafts", async () => {
    const app = openApp();
    const res = await app.request("/api/drafts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DraftsResponse;
    // All three pending outward artifacts — explicit-pending, missing-status,
    // and blank-status — surface in the tray (the routing default catches the
    // absent/blank cases too).
    expect(body.total).toBe(3);
    expect(body.drafts.map((d) => d.id).sort()).toEqual([
      "draft-blank-status-1",
      "draft-missing-status-1",
      "draft-pending-1",
    ]);
    // approved outward + internal are NOT drafts
    expect(body.drafts.map((d) => d.id)).not.toContain("approved-snippet-1");
    expect(body.drafts.map((d) => d.id)).not.toContain("pod-1");
  });
});

describe("POST /api/drafts/:id/approve", () => {
  test("flips approval_status on disk; item then publishes and leaves the tray", async () => {
    const app = openApp();

    const res = await app.request("/api/drafts/draft-pending-1/approve", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, approval_status: "approved" });

    // On disk: approval_status is now "approved" and the file still validates.
    const onDisk = JSON.parse(
      await readFile(join(fx.dir, "social-post", "pending-banger", "artifact.json"), "utf8"),
    ) as { approval_status: string; id: string };
    expect(onDisk.approval_status).toBe("approved");
    expect(onDisk.id).toBe("draft-pending-1");

    // Now in the published feed…
    const cards = (await (await app.request("/api/cards")).json()) as CardsResponse;
    expect(cards.cards.map((c) => c.id)).toContain("draft-pending-1");

    // …and gone from the tray (the other pending drafts remain).
    const drafts = (await (await app.request("/api/drafts")).json()) as DraftsResponse;
    expect(drafts.drafts.map((d) => d.id)).not.toContain("draft-pending-1");
    expect(drafts.total).toBe(2);
  });

  test("404s a non-draft id (an internal artifact) and never publishes-twice", async () => {
    const app = openApp();
    // pod-1 is internal, not a pending outward draft.
    const res = await app.request("/api/drafts/pod-1/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("404s an already-approved outward artifact", async () => {
    const app = openApp();
    const res = await app.request("/api/drafts/approved-snippet-1/approve", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("404s an unknown id", async () => {
    const app = openApp();
    const res = await app.request("/api/drafts/ghost-99/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/drafts/:id/kill", () => {
  test("quarantines the dir, logs a `less` event, drops it from both surfaces", async () => {
    const app = openApp();
    const res = await app.request("/api/drafts/draft-pending-1/kill", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, quarantined: true });

    // Quarantined, not deleted: original gone, copy lives under .quarantine/ at
    // <slug>__<id> (the id suffix makes a slug collision lossless — see below).
    expect(existsSync(join(fx.dir, "social-post", "pending-banger"))).toBe(false);
    expect(
      existsSync(
        join(fx.dir, ".quarantine", "social-post", "pending-banger__draft-pending-1", "artifact.json"),
      ),
    ).toBe(true);

    // Gone from the tray (the other pending drafts remain) and never in the feed.
    const drafts = (await (await app.request("/api/drafts")).json()) as DraftsResponse;
    expect(drafts.drafts.map((d) => d.id)).not.toContain("draft-pending-1");
    expect(drafts.total).toBe(2);
    const cards = (await (await app.request("/api/cards")).json()) as CardsResponse;
    expect(cards.cards.map((c) => c.id)).not.toContain("draft-pending-1");

    // A `less` feedback event was logged (reuses the existing machinery).
    const events = await readEvents(feedbackFile);
    const killed = events.find((e) => e.artifact_id === "draft-pending-1");
    expect(killed?.action).toBe("less");
  });

  // PR #12 Low regression: two DISTINCT drafts (different ids) can slugify to the
  // same <type>/<slug>. Killing the second MUST NOT clobber the first's quarantined
  // copy. The `__<id>` suffix on the quarantine dest makes recovery lossless.
  test("a slug collision between two distinct drafts is LOSSLESS in quarantine", async () => {
    const app = openApp();

    // Kill the first draft (id=draft-pending-1, social-post/pending-banger).
    const r1 = await app.request("/api/drafts/draft-pending-1/kill", { method: "POST" });
    expect(r1.status).toBe(200);
    const q1 = join(fx.dir, ".quarantine", "social-post", "pending-banger__draft-pending-1", "artifact.json");
    expect(existsSync(q1)).toBe(true);

    // A SECOND, distinct draft lands at the SAME <type>/<slug> path (same slug,
    // different artifact id) — the realistic collision after the first was killed
    // and its source dir moved to quarantine.
    const collisionDir = join(fx.dir, "social-post", "pending-banger");
    await mkdir(collisionDir, { recursive: true });
    await writeFile(
      join(collisionDir, "artifact.json"),
      JSON.stringify({
        id: "draft-pending-2",
        type: "social-post",
        headline: "A different draft that slugifies the same",
        body: "Distinct content, same slug.",
        approval_status: "pending",
        audience: "public",
        platform: "x",
        generated_at: "2026-06-09T12:00:00Z",
        tags: [],
        source_transcripts: ["/tmp/t.md"],
        quality: { critic_pass: true, quotes_verified: true },
      }),
    );

    // Kill the second draft too.
    const r2 = await app.request("/api/drafts/draft-pending-2/kill", { method: "POST" });
    expect(r2.status).toBe(200);

    // LOSSLESS: BOTH quarantined copies survive under distinct __<id> dirs.
    expect(existsSync(q1)).toBe(true); // the first was NOT clobbered
    const q2 = join(fx.dir, ".quarantine", "social-post", "pending-banger__draft-pending-2", "artifact.json");
    expect(existsSync(q2)).toBe(true);

    // And they are genuinely distinct artifacts (different ids on disk).
    const a1 = JSON.parse(await readFile(q1, "utf8")) as { id: string };
    const a2 = JSON.parse(await readFile(q2, "utf8")) as { id: string };
    expect(a1.id).toBe("draft-pending-1");
    expect(a2.id).toBe("draft-pending-2");
  });
});

describe("POST /api/drafts/:id/expand", () => {
  test("records a `promote` event; the draft STAYS in the tray", async () => {
    const app = openApp();
    const res = await app.request("/api/drafts/draft-pending-1/expand", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: "expand", recorded: true });

    const events = await readEvents(feedbackFile);
    expect(events.find((e) => e.artifact_id === "draft-pending-1")?.action).toBe("promote");

    // Still pending in the tray (expand records intent but does not resolve).
    const drafts = (await (await app.request("/api/drafts")).json()) as DraftsResponse;
    expect(drafts.drafts.map((d) => d.id)).toContain("draft-pending-1");
    expect(drafts.total).toBe(3);
  });
});

describe("path-traversal on :id is blocked", () => {
  test("approve with a traversal id → 400, no fs touch", async () => {
    const app = openApp();
    const res = await app.request(
      "/api/drafts/..%2f..%2f..%2fetc%2fpasswd/approve",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
  });

  test("kill with a traversal id → 400", async () => {
    const app = openApp();
    const res = await app.request("/api/drafts/..%2f..%2fsecret/kill", { method: "POST" });
    expect(res.status).toBe(400);
  });

  test("expand with a backslash/dot-dot id → 400", async () => {
    const app = openApp();
    const res = await app.request("/api/drafts/..%5c..%5csecret/expand", { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("all drafts routes are gated (unauth → 401)", () => {
  test("GET /api/drafts → 401", async () => {
    const app = gatedApp();
    expect((await app.request("/api/drafts")).status).toBe(401);
  });

  test("POST /api/drafts/:id/approve → 401 (before any fs/route logic)", async () => {
    const app = gatedApp();
    const res = await app.request("/api/drafts/draft-pending-1/approve", { method: "POST" });
    expect(res.status).toBe(401);
    // And the artifact was NOT modified on disk.
    const onDisk = JSON.parse(
      await readFile(join(fx.dir, "social-post", "pending-banger", "artifact.json"), "utf8"),
    ) as { approval_status: string };
    expect(onDisk.approval_status).toBe("pending");
  });

  test("POST /api/drafts/:id/kill → 401", async () => {
    const app = gatedApp();
    expect(
      (await app.request("/api/drafts/draft-pending-1/kill", { method: "POST" })).status,
    ).toBe(401);
    // Not quarantined.
    expect(existsSync(join(fx.dir, "social-post", "pending-banger"))).toBe(true);
  });

  test("POST /api/drafts/:id/expand → 401", async () => {
    const app = gatedApp();
    expect(
      (await app.request("/api/drafts/draft-pending-1/expand", { method: "POST" })).status,
    ).toBe(401);
  });

  test("with a valid session the gate lets the request through", async () => {
    const app = gatedApp();
    const signIn = await app.request("/auth/openkey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: ALLOWED, keyId: "k", keyType: "MANAGED" }),
    });
    const setCookie = signIn.headers.get("set-cookie") ?? "";
    const m = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
    const cookie = `${SESSION_COOKIE_NAME}=${m![1]}`;

    const res = await app.request("/api/drafts", { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});
