// auth.ts — OpenKey front-door gate: Hono middleware + /auth routes.
//
// Trust model (mirrors meet-fast Phase 0.7, hardened with an allowlist):
//   - The browser drives `openkey.connect()` (WebAuthn passkey ceremony —
//     needs a secure context, so HTTPS in front of this server).
//   - The SPA POSTs the resulting AuthResult to /auth/openkey. We do NOT
//     verify the WebAuthn signature server-side; instead the address is
//     checked against OPENKEY_ALLOWED_ADDRESSES (single-user model: only
//     Hunter's address mints a session). A forged AuthResult with an
//     allowlisted address would pass — acceptable for a personal,
//     behind-a-tunnel deploy; swap to an OAuth code exchange if this ever
//     goes multi-user.
//   - On success we issue an opaque session token (sessions.db, 7-day TTL)
//     in an httpOnly Secure SameSite=Lax cookie.
//
// Gate matrix:
//   OPEN : /auth/*  (sign-in must work pre-session)
//   OPEN : SPA shell + static assets (the catch-all `*` route — the sign-in
//          page has to load; the shell leaks no artifact data)
//   GATED: /api/*   (cards, feedback, preferences, summary)
//   GATED: /media/* (artifact media files)
//
// Dev bypass: AUTH_DISABLED=1 passes everything (local HTTP dev — passkeys
// don't work without a secure context). server.ts logs a loud warning.

import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  SessionStore,
  type OpenKeyIdentity,
  type SessionRow,
} from "./session.ts";

/**
 * Route patterns that require a session, registered via Hono's own matcher
 * (`app.use(pattern, ...)`). Everything else is open.
 *
 * SECURITY: the gate MUST use Hono's matcher — never a hand-rolled prefix
 * check on the raw URL. Hono percent-decodes the path before matching
 * routes, so a raw-URL check sees `/%61pi/cards` while the router serves
 * `/api/cards`: two parsers, one bypass. With the gate registered as route
 * middleware there is a single parser and the encoded form is gated too.
 */
export const GATED_ROUTES = ["/api/*", "/media/*"] as const;

export interface AuthOptions {
  /** Override the sessions.db path (tests point this at a tmpdir). */
  sessionsDbPath?: string;
  /** Allowlisted OpenKey addresses (case-insensitive). */
  allowedAddresses?: string[];
  /** Skip the gate entirely (local HTTP dev). */
  disabled?: boolean;
}

export interface ResolvedAuth {
  /** null when disabled — no sessions.db is created for bypassed apps. */
  store: SessionStore | null;
  /** Lowercased allowlist. */
  allowed: ReadonlySet<string>;
  disabled: boolean;
}

export type AuthEnv = {
  Variables: {
    session: SessionRow | null;
  };
};

export function parseAllowedAddresses(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Fill unset options from the environment (OPENKEY_ALLOWED_ADDRESSES, AUTH_DISABLED). */
export function resolveAuth(opts: AuthOptions = {}): ResolvedAuth {
  const disabled = opts.disabled ?? process.env.AUTH_DISABLED === "1";
  const allowed = new Set(
    (opts.allowedAddresses ??
      parseAllowedAddresses(process.env.OPENKEY_ALLOWED_ADDRESSES ?? "")
    ).map((a) => a.toLowerCase()),
  );
  const store = disabled ? null : new SessionStore(opts.sessionsDbPath);
  // Evict expired rows at startup and hourly thereafter (unref'd timer —
  // never keeps the process or test runner alive). Lazy eviction on access
  // alone lets abandoned sessions accumulate forever.
  store?.startPurgeTimer();
  return { store, allowed, disabled };
}

function sessionFromCookie(c: Context<AuthEnv>, auth: ResolvedAuth): SessionRow | null {
  if (!auth.store) return null;
  const cookie = getCookie(c, SESSION_COOKIE_NAME);
  return cookie ? auth.store.get(cookie) : null;
}

/**
 * Permissive session loader. Registered as `app.use("*", ...)` so every
 * handler (notably /auth/me) can read c.var.session. Never blocks — the SPA
 * shell + static assets stay reachable so the sign-in page can render.
 */
export function sessionLoader(auth: ResolvedAuth): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    c.set("session", auth.disabled ? null : sessionFromCookie(c, auth));
    return next();
  };
}

/**
 * Blocking gate. Registered on GATED_ROUTES via Hono's matcher (see the
 * GATED_ROUTES doc comment for why it must not parse the URL itself).
 * Redirect-to-signin is handled client-side off the 401 (hash-routed SPA).
 */
export function authGate(auth: ResolvedAuth): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (auth.disabled) return next();
    if (!c.var.session) return c.json({ error: "unauthorized" }, 401);
    return next();
  };
}

/** Mount the gate + /auth routes onto the app. Call BEFORE registering routes. */
export function setupAuth(app: Hono<AuthEnv>, auth: ResolvedAuth): void {
  app.use("*", sessionLoader(auth));
  for (const pattern of GATED_ROUTES) {
    app.use(pattern, authGate(auth));
  }

  /**
   * POST /auth/openkey
   * Body: AuthResult JSON from `openkey.connect()` — { address, keyId?, keyType?, ... }.
   * 200 + session cookie when the address is allowlisted; 403 otherwise.
   */
  app.post("/auth/openkey", async (c) => {
    if (auth.disabled || !auth.store) {
      return c.json({ identity: { address: "dev-bypass" }, authDisabled: true });
    }
    let body: Record<string, unknown>;
    try {
      const raw: unknown = await c.req.json();
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return c.json({ error: "invalid_auth_result" }, 400);
      }
      body = raw as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (typeof body.address !== "string" || !body.address.trim()) {
      return c.json({ error: "invalid_auth_result" }, 400);
    }
    const address = body.address.trim();
    if (!auth.allowed.has(address.toLowerCase())) {
      return c.json({ error: "address_not_allowed" }, 403);
    }

    const identity: OpenKeyIdentity = { address };
    if (typeof body.keyId === "string") identity.keyId = body.keyId;
    if (typeof body.keyType === "string") identity.keyType = body.keyType;

    // Single-user model: a fresh sign-in invalidates every prior session for
    // the address, so old cookies stop working instead of staying live for
    // the rest of their TTL.
    auth.store.deleteForAddress(address);
    const session = auth.store.create(identity);
    setCookie(c, SESSION_COOKIE_NAME, session.session_id, {
      httpOnly: true,
      secure: true, // HTTPS in prod (tunnel); local dev uses AUTH_DISABLED
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.json({ identity });
  });

  /** POST /auth/signout — kill the session, clear the cookie. Idempotent. */
  app.post("/auth/signout", (c) => {
    const cookie = getCookie(c, SESSION_COOKIE_NAME);
    if (cookie && auth.store) auth.store.delete(cookie);
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  });

  /** GET /auth/me — 200 with identity when signed in, 401 otherwise. */
  app.get("/auth/me", (c) => {
    if (auth.disabled) {
      return c.json({
        identity: { address: "dev-bypass" },
        authDisabled: true,
      });
    }
    const session = c.var.session;
    if (!session) return c.json({ error: "unauthorized" }, 401);
    return c.json({ identity: session.identity });
  });
}
