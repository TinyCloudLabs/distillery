// auth.test.ts — integration tests for the OpenKey front-door gate.
//
// Mirrors meet-fast's tests/auth.test.ts approach: exercise the full HTTP
// surface via app.request() with an isolated tmpdir sessions.db. The fake
// AuthResult stands in for the browser passkey ceremony — the backend trusts
// the posted result and gates purely on the address allowlist (single-user
// trust model).

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { SESSION_COOKIE_NAME, SessionStore } from "../src/session.ts";
import { makeFixture, type Fixture } from "./fixtures.ts";

const ALLOWED = "0x6Ac0836fF53107F990233688A95CF44f58bBbFD6";

let fx: Fixture;
let stateDir: string;
let sessionsDbPath: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  fx = await makeFixture();
  stateDir = await mkdtemp(join(tmpdir(), "distillery-auth-"));
  await writeFile(join(stateDir, "index.html"), "<!doctype html><title>feed</title>");
  sessionsDbPath = join(stateDir, "sessions.db");
  app = createApp({
    artifactsDir: fx.dir,
    distDir: stateDir,
    feedbackFile: join(stateDir, "events.jsonl"),
    auth: {
      sessionsDbPath,
      allowedAddresses: [ALLOWED],
      disabled: false,
    },
  });
});

afterAll(async () => {
  await fx.cleanup();
  await rm(stateDir, { recursive: true, force: true });
});

async function signIn(address: string): Promise<Response> {
  return await app.request("/auth/openkey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, keyId: "test-key", keyType: "MANAGED" }),
  });
}

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  if (!m) throw new Error(`no session cookie in: ${setCookie}`);
  return `${SESSION_COOKIE_NAME}=${m[1]}`;
}

describe("unauthenticated requests", () => {
  test("/api/cards → 401", async () => {
    const res = await app.request("/api/cards");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("/api/feedback POST → 401 (gated before validation)", async () => {
    const res = await app.request("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact_id: "pod-1", action: "more" }),
    });
    expect(res.status).toBe(401);
  });

  test("/api/feedback/summary → 401", async () => {
    const res = await app.request("/api/feedback/summary");
    expect(res.status).toBe(401);
  });

  test("/media/* → 401", async () => {
    const res = await app.request("/media/podcast/newest-podcast/hero.png");
    expect(res.status).toBe(401);
  });

  test("SPA shell stays reachable (sign-in page must load)", async () => {
    const root = await app.request("/");
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("<title>feed</title>");

    const deep = await app.request("/some/client/route");
    expect(deep.status).toBe(200);
  });

  test("/auth/me → 401 (not a redirect)", async () => {
    const res = await app.request("/auth/me");
    expect(res.status).toBe(401);
  });

  test("/auth/signout reachable without a session (idempotent)", async () => {
    const res = await app.request("/auth/signout", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /auth/openkey", () => {
  test("allowlisted address → session cookie → /api + /media unlock", async () => {
    const res = await signIn(ALLOWED);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");

    const cookie = cookieFrom(res);
    const cards = await app.request("/api/cards", { headers: { cookie } });
    expect(cards.status).toBe(200);

    const media = await app.request("/media/podcast/newest-podcast/hero.png", {
      headers: { cookie },
    });
    expect(media.status).toBe(200);

    const me = await app.request("/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { identity: { address: string } };
    expect(body.identity.address).toBe(ALLOWED);
  });

  test("allowlist comparison is case-insensitive", async () => {
    const res = await signIn(ALLOWED.toUpperCase().replace("0X", "0x"));
    expect(res.status).toBe(200);
  });

  test("non-allowlisted address → 403, no cookie", async () => {
    const res = await signIn("0x1111111111111111111111111111111111111111");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "address_not_allowed" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("garbage payloads → 400", async () => {
    const missing = await app.request("/auth/openkey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyId: "k" }),
    });
    expect(missing.status).toBe(400);

    const notJson = await app.request("/auth/openkey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ nope",
    });
    expect(notJson.status).toBe(400);

    const arr = await app.request("/auth/openkey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(arr.status).toBe(400);
  });
});

describe("session lifecycle", () => {
  test("bogus cookie → 401", async () => {
    const res = await app.request("/api/cards", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-real-token` },
    });
    expect(res.status).toBe(401);
  });

  test("expired session → 401 (and the row is evicted)", async () => {
    // Mint a pre-expired row directly against the same sessions.db.
    const store = new SessionStore(sessionsDbPath);
    const session = store.create({ address: ALLOWED }, -1000);
    const cookie = `${SESSION_COOKIE_NAME}=${session.session_id}`;

    const res = await app.request("/api/cards", { headers: { cookie } });
    expect(res.status).toBe(401);
    expect(store.get(session.session_id)).toBeNull();
  });

  test("signout kills the session", async () => {
    const cookie = cookieFrom(await signIn(ALLOWED));

    const before = await app.request("/api/cards", { headers: { cookie } });
    expect(before.status).toBe(200);

    const out = await app.request("/auth/signout", {
      method: "POST",
      headers: { cookie },
    });
    expect(out.status).toBe(200);

    const after = await app.request("/api/cards", { headers: { cookie } });
    expect(after.status).toBe(401);
  });
});

describe("AUTH_DISABLED bypass", () => {
  test("everything passes without a cookie; /auth/me reports the bypass", async () => {
    const bypassed = createApp({
      artifactsDir: fx.dir,
      distDir: stateDir,
      feedbackFile: join(stateDir, "events-bypass.jsonl"),
      auth: { disabled: true },
    });

    const cards = await bypassed.request("/api/cards");
    expect(cards.status).toBe(200);

    const media = await bypassed.request("/media/podcast/newest-podcast/hero.png");
    expect(media.status).toBe(200);

    const me = await bypassed.request("/auth/me");
    expect(me.status).toBe(200);
    const body = (await me.json()) as { authDisabled?: boolean };
    expect(body.authDisabled).toBe(true);
  });
});
