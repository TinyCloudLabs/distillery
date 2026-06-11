// Hono app factory — kept separate from the serve entrypoint so tests can
// exercise the full HTTP surface via app.request() without binding a port.

import { Hono } from "hono";
import { rename } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  appendEvent,
  isFeedbackAction,
  readEvents,
  summarizeEvents,
  FEEDBACK_ACTIONS,
  type FeedbackEvent,
} from "../../skills/_shared/lib/feedback.ts";
import { scanArtifacts } from "./scan.ts";
import { resolveAuth, setupAuth, type AuthEnv, type AuthOptions } from "./auth.ts";
import type { CardsResponse } from "./types.ts";

export interface AppOptions {
  /** Absolute path to the artifacts root. */
  artifactsDir: string;
  /** Absolute path to the built SPA (web/dist). Optional for API-only tests. */
  distDir?: string;
  /** Absolute path to the feedback JSONL log (feedback/events.jsonl). */
  feedbackFile: string;
  /**
   * OpenKey front-door auth. Unset fields resolve from the environment
   * (OPENKEY_ALLOWED_ADDRESSES, AUTH_DISABLED) — see src/auth.ts. Tests
   * inject `{ disabled: true }` or a tmpdir sessionsDbPath + allowlist.
   */
  auth?: AuthOptions;
  /** Absolute path to PREFERENCES.md. Optional — endpoints 404 without it. */
  preferencesFile?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** PUT /api/preferences size cap, bytes. */
const PREFERENCES_MAX_BYTES = 10 * 1024;

function sha256Hex(data: ArrayBuffer | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

/** Quoted sha256 of the preferences file bytes (a missing file hashes as empty). */
async function preferencesEtag(path: string): Promise<string> {
  const f = Bun.file(path);
  const buf = (await f.exists()) ? await f.arrayBuffer() : new ArrayBuffer(0);
  return `"${sha256Hex(buf)}"`;
}

/** Strip ETag quotes and any weak-validator prefix for comparison. */
function unquoteEtag(value: string): string {
  return value.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1");
}

/** Resolve a child path and refuse anything that escapes the base dir. */
function safeJoin(base: string, ...parts: string[]): string | null {
  const target = resolve(base, ...parts);
  if (target === base || target.startsWith(base + sep)) return target;
  return null;
}

// Overrides where Bun's mime table disagrees with what browsers want:
// .m4a (AAC audio from make-podcast) must be audio/mp4 — Bun reports
// audio/x-m4a, which some players (notably iOS Safari) handle poorly.
const CONTENT_TYPE_OVERRIDES: Record<string, string> = {
  ".m4a": "audio/mp4",
};

function contentTypeFor(path: string, file: ReturnType<typeof Bun.file>): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return CONTENT_TYPE_OVERRIDES[ext] ?? file.type ?? "application/octet-stream";
}

function fileResponse(
  path: string,
  file: ReturnType<typeof Bun.file>,
  rangeHeader: string | null,
  cacheControl?: string,
): Response {
  const size = file.size;
  const type = contentTypeFor(path, file) || "application/octet-stream";
  const extra: Record<string, string> = cacheControl ? { "Cache-Control": cacheControl } : {};

  // Range support — iOS Safari requires it to seek (and often to play) audio.
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : NaN;
      let end = m[2] ? parseInt(m[2], 10) : NaN;
      if (Number.isNaN(start)) {
        // suffix range: last N bytes
        start = Math.max(0, size - end!);
        end = size - 1;
      } else if (Number.isNaN(end) || end >= size) {
        end = size - 1;
      }
      if (start >= size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
          ...extra,
        },
      });
    }
  }

  return new Response(file, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      ...extra,
    },
  });
}

export function createApp(opts: AppOptions): Hono<AuthEnv> {
  const artifactsDir = resolve(opts.artifactsDir);
  const distDir = opts.distDir ? resolve(opts.distDir) : null;
  const feedbackFile = resolve(opts.feedbackFile);
  const preferencesFile = opts.preferencesFile ? resolve(opts.preferencesFile) : null;
  const app = new Hono<AuthEnv>();

  // Front-door gate: must be registered before any route. Gates /api/* and
  // /media/*; /auth/* and the SPA shell stay open (see src/auth.ts).
  setupAuth(app, resolveAuth(opts.auth));

  // PREFERENCES.md is plain text both ways: GET returns the raw file, PUT
  // replaces it. The panel is honest about being a file editor — the
  // [learned]-bullet conventions live in the file itself, not the API.
  //
  // The file is co-written by humans (this panel) and agents
  // (distill-preferences), so PUT is guarded with optimistic concurrency:
  // GET returns an ETag (sha256 of the file bytes; a missing file hashes as
  // empty), PUT requires If-Match and answers 409 when the file changed
  // underneath the client, who then refetches and re-applies their edit.
  app.get("/api/preferences", async (c) => {
    if (!preferencesFile) return c.text("preferences file not configured", 404);
    const f = Bun.file(preferencesFile);
    const buf = (await f.exists()) ? await f.arrayBuffer() : new ArrayBuffer(0);
    return c.text(new TextDecoder().decode(buf), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      ETag: `"${sha256Hex(buf)}"`,
    });
  });

  app.put("/api/preferences", async (c) => {
    if (!preferencesFile) return c.json({ error: "preferences file not configured" }, 404);
    const ifMatch = c.req.header("if-match");
    if (!ifMatch) {
      return c.json(
        { error: "If-Match header required (GET /api/preferences returns the current ETag)" },
        428,
      );
    }
    const text = await c.req.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > PREFERENCES_MAX_BYTES) {
      return c.json(
        { error: `preferences too large: ${bytes} bytes (max ${PREFERENCES_MAX_BYTES})` },
        413,
      );
    }
    const current = await preferencesEtag(preferencesFile);
    if (unquoteEtag(ifMatch) !== unquoteEtag(current)) {
      return c.json(
        { error: "preferences changed on disk — refetch and reapply your edit", etag: current },
        409,
        { ETag: current },
      );
    }
    // Atomic replace: skills read PREFERENCES.md directly, and Bun.write
    // truncates in place — write a sibling temp file and rename() over it so
    // no reader ever observes a partial file.
    const tmp = `${preferencesFile}.tmp-${process.pid}-${Date.now()}`;
    await Bun.write(tmp, text);
    await rename(tmp, preferencesFile);
    const etag = `"${sha256Hex(new TextEncoder().encode(text))}"`;
    return c.json({ ok: true, bytes, etag }, 200, { ETag: etag });
  });

  app.post("/api/feedback", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return c.json({ error: "body must be a JSON object" }, 400);
    }
    const b = raw as Record<string, unknown>;

    if (typeof b.artifact_id !== "string" || !b.artifact_id.trim()) {
      return c.json({ error: "artifact_id: required non-empty string" }, 400);
    }
    if (!isFeedbackAction(b.action)) {
      return c.json(
        { error: `action: must be one of ${FEEDBACK_ACTIONS.join(", ")}` },
        400,
      );
    }
    if (b.note !== undefined && typeof b.note !== "string") {
      return c.json({ error: "note: must be a string when present" }, 400);
    }

    const all = await scanArtifacts(artifactsDir);
    const card = all.find((x) => x.id === b.artifact_id);
    if (!card) return c.json({ error: "artifact not found" }, 404);

    const event: FeedbackEvent = {
      artifact_id: card.id,
      artifact_type: card.type, // the artifact on disk is authoritative
      action: b.action,
      ts: new Date().toISOString(),
    };
    if (typeof b.note === "string" && b.note.trim()) event.note = b.note.trim();

    await appendEvent(feedbackFile, event);
    return c.json({ ok: true, event }, 201);
  });

  app.get("/api/feedback/summary", async (c) => {
    const events = await readEvents(feedbackFile);
    const cards = await scanArtifacts(artifactsDir);
    const summary = summarizeEvents(events, cards);
    return c.json(summary);
  });

  app.get("/api/cards", async (c) => {
    const limitRaw = parseInt(c.req.query("limit") ?? "", 10);
    const offsetRaw = parseInt(c.req.query("offset") ?? "", 10);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.isNaN(limitRaw) ? DEFAULT_LIMIT : limitRaw),
    );
    const offset = Math.max(0, Number.isNaN(offsetRaw) ? 0 : offsetRaw);

    const all = await scanArtifacts(artifactsDir);
    const page = all.slice(offset, offset + limit);
    const body: CardsResponse = {
      cards: page,
      total: all.length,
      offset,
      hasMore: offset + page.length < all.length,
    };
    return c.json(body);
  });

  app.get("/api/cards/:type/:slug", async (c) => {
    const { type, slug } = c.req.param();
    const all = await scanArtifacts(artifactsDir);
    const card = all.find((x) => x.type === type && x.slug === slug);
    if (!card) return c.json({ error: "not found" }, 404);
    return c.json(card);
  });

  app.get("/media/:type/:slug/:file", async (c) => {
    const { type, slug, file } = c.req.param();
    const path = safeJoin(artifactsDir, type, slug, file);
    if (!path) return c.text("forbidden", 403);
    const f = Bun.file(path);
    if (!(await f.exists())) return c.text("not found", 404);
    return fileResponse(path, f, c.req.header("range") ?? null);
  });

  // Static SPA with index.html fallback (hash routing means this is mostly "/").
  // Cache policy: vite assets are content-hashed → immutable; everything else
  // (index.html, sw.js, manifest) must revalidate so deploys land immediately.
  app.get("*", async (c) => {
    if (!distDir) return c.text("feed not built — run: bun run build", 404);
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    const path = safeJoin(distDir, "." + pathname);
    if (path && path !== distDir) {
      const f = Bun.file(path);
      if (await f.exists()) {
        const cache = pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
        return fileResponse(path, f, c.req.header("range") ?? null, cache);
      }
    }
    const indexPath = join(distDir, "index.html");
    const index = Bun.file(indexPath);
    if (await index.exists()) return fileResponse(indexPath, index, null, "no-cache");
    return c.text("feed not built — run: bun run build", 404);
  });

  return app;
}
