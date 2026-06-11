// session.ts — front-door session store for the OpenKey gate.
//
// Mirrors meet-fast's src/services/session.ts: the browser drives the
// OpenKey passkey ceremony; the backend trusts the posted AuthResult
// (single-user model — only allowlisted addresses get a session) and issues
// an opaque token stored here. The token rides an httpOnly cookie; the auth
// middleware looks it up on every gated request.
//
// Owns its own SQLite file (feed/sessions.db by default — gitignored).
// Schema:
//   session_id  TEXT PRIMARY KEY  -- random opaque token (cookie value)
//   address     TEXT              -- lowercased OpenKey address (queryable)
//   identity    TEXT              -- JSON-encoded AuthResult subset
//   expires_at  INTEGER           -- unix ms
//   created_at  INTEGER           -- unix ms

import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_COOKIE_NAME = "distillery_session";
export const PURGE_INTERVAL_MS = 60 * 60 * 1000; // hourly

/** Default: feed/sessions.db (this file lives in feed/src/). */
export const DEFAULT_SESSIONS_DB_PATH = resolve(
  import.meta.dir,
  "..",
  "sessions.db",
);

/** Identity shape — the subset of @openkey/sdk's AuthResult we persist. */
export interface OpenKeyIdentity {
  address: string;
  keyId?: string;
  keyType?: string;
}

export interface SessionRow {
  session_id: string;
  address: string;
  identity: OpenKeyIdentity;
  expires_at: number;
  created_at: number;
}

/**
 * Per-instance store (no module-level singleton) so each createApp() in the
 * test suite can point at its own tmpdir database without cross-talk.
 */
export class SessionStore {
  readonly path: string;
  private db: Database;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(path: string = DEFAULT_SESSIONS_DB_PATH) {
    this.path = path;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT    PRIMARY KEY,
        address    TEXT    NOT NULL,
        identity   TEXT    NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /** Create a session. `ttlMs` is overridable so tests can mint expired rows. */
  create(identity: OpenKeyIdentity, ttlMs: number = SESSION_TTL_MS): SessionRow {
    const now = Date.now();
    const session_id = randomBytes(32).toString("base64url");
    const address = identity.address.toLowerCase();
    const expires_at = now + ttlMs;
    this.db
      .query(
        `INSERT INTO sessions (session_id, address, identity, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(session_id, address, JSON.stringify(identity), expires_at, now);
    return { session_id, address, identity, expires_at, created_at: now };
  }

  /** Look up a session; expired or corrupt rows are evicted and return null. */
  get(session_id: string): SessionRow | null {
    if (!session_id) return null;
    const row = this.db
      .query<
        {
          session_id: string;
          address: string;
          identity: string;
          expires_at: number;
          created_at: number;
        },
        [string]
      >(
        `SELECT session_id, address, identity, expires_at, created_at
         FROM sessions WHERE session_id = ?`,
      )
      .get(session_id);
    if (!row) return null;
    if (Number(row.expires_at) < Date.now()) {
      this.delete(session_id);
      return null;
    }
    let identity: OpenKeyIdentity;
    try {
      identity = JSON.parse(row.identity) as OpenKeyIdentity;
    } catch {
      this.delete(session_id); // corrupt row — evict
      return null;
    }
    return {
      session_id: row.session_id,
      address: row.address,
      identity,
      expires_at: Number(row.expires_at),
      created_at: Number(row.created_at),
    };
  }

  delete(session_id: string): void {
    this.db.query(`DELETE FROM sessions WHERE session_id = ?`).run(session_id);
  }

  /**
   * Delete every session for an address (lowercased on insert, so compare
   * lowercased). Called on sign-in so re-auth invalidates old cookies
   * instead of accumulating live tokens (single-user model).
   */
  deleteForAddress(address: string): number {
    const res = this.db
      .query(`DELETE FROM sessions WHERE address = ?`)
      .run(address.toLowerCase());
    return Number(res.changes ?? 0);
  }

  purgeExpired(): number {
    const res = this.db
      .query(`DELETE FROM sessions WHERE expires_at < ?`)
      .run(Date.now());
    return Number(res.changes ?? 0);
  }

  /**
   * Purge expired rows now and then hourly. The timer is unref'd so it never
   * keeps the process (or the test runner) alive. Idempotent; cleared by
   * close().
   */
  startPurgeTimer(intervalMs: number = PURGE_INTERVAL_MS): void {
    this.purgeExpired();
    if (this.purgeTimer) return;
    this.purgeTimer = setInterval(() => this.purgeExpired(), intervalMs);
    this.purgeTimer.unref?.();
  }

  close(): void {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
    this.db.close();
  }
}
