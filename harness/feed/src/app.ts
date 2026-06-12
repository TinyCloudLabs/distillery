// Hono app factory — kept separate from the serve entrypoint so tests can
// exercise the full HTTP surface via app.request() without binding a port.

import { Hono } from "hono";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  appendEvent,
  isFeedbackAction,
  readEvents,
  summarizeEvents,
  FEEDBACK_ACTIONS,
  type FeedbackEvent,
} from "../../../skills/_shared/lib/feedback.ts";
import { validateArtifact } from "../../../skills/_shared/lib/artifact.ts";
import { scanArtifacts } from "./scan.ts";
import { isPendingDraft, isPublished } from "./routing.ts";
import { resolveAuth, setupAuth, type AuthEnv, type AuthOptions } from "./auth.ts";
import {
  isValidRunId,
  parseGenerateBody,
  readRunStatus,
  readRunProgress,
  startGeneration,
  type GenerateConfig,
} from "./generate.ts";
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
  /**
   * Generate-button config (spec §8). When unset, POST /api/generate is
   * disabled (501) — tests inject a fake spawn + tmpdir runs dir. In prod the
   * server passes `{ repoRoot }`, and the spawned run inherits the server's env
   * (TRANSCRIPT_DIRS + GEMINI key + claude on PATH — see .env.example).
   */
  generate?: GenerateConfig;
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

/**
 * Path-safe artifact id guard for the drafts routes — same hardening posture
 * as generate.ts's `isValidRunId`. Artifact ids are UUIDs (crypto.randomUUID)
 * but we accept any opaque token that can't be used for traversal: bounded
 * length, no slash / backslash / dot-dot / null byte / percent / whitespace.
 * We never path-join the id directly (the dir is taken from the scanned
 * card's type+slug), but rejecting a malformed id up front means a request
 * like `/api/drafts/..%2f..%2fsecret/approve` is a 400, not a lookup.
 */
const ARTIFACT_ID_RE = /^[0-9A-Za-z:._-]+$/;
function isValidArtifactId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return false;
  if (id.includes("..")) return false;
  return ARTIFACT_ID_RE.test(id);
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
  const generateConfig = opts.generate ?? null;
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

  // POST /api/generate — fire the feed-run loop on demand (spec §8). GATED by
  // the /api/* front-door (an unauth POST → 401 before any of this). This is the
  // highest-privilege route: a full run spends Gemini money + publishes to the
  // live feed. Returns 202 + { run_id } immediately (the run is spawned DETACHED
  // and outlives the request); a second concurrent run → 409 (lockfile, R1).
  // dry_run (default false) → a safe preview (brief + cursor only, no spend).
  app.post("/api/generate", async (c) => {
    if (!generateConfig) {
      return c.json({ error: "generation not configured on this server" }, 501);
    }
    let raw: unknown;
    try {
      // An empty body is allowed (defaults: daily, not dry).
      const text = await c.req.text();
      raw = text.trim() ? JSON.parse(text) : undefined;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const parsed = parseGenerateBody(raw);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const result = await startGeneration(parsed, generateConfig);
    if (!result.ok) {
      // A run is already in progress — reject (spec R1: reject, not queue).
      return c.json(
        { error: "a generation run is already in progress", pid: result.pid },
        409,
      );
    }
    return c.json(
      { run_id: result.run_id, mode: parsed.mode ?? "daily", dry_run: parsed.dry_run ?? false },
      202,
    );
  });

  // GET /api/generate/:run_id — poll a run's status off index/runs/<run_id>/.
  app.get("/api/generate/:run_id", async (c) => {
    if (!generateConfig) {
      return c.json({ error: "generation not configured on this server" }, 501);
    }
    const runId = c.req.param("run_id");
    // SECURITY (path traversal): reject an out-of-format run_id with 400 BEFORE
    // any path join. The strict allowlist (ISO-timestamp charset, no `..`, no
    // slash) makes `GET /api/generate/..%2f..%2fsecret` a 400, not a path read.
    if (!isValidRunId(runId)) return c.json({ error: "invalid run_id" }, 400);
    // `readRunStatus` is the 404 oracle (an id with no run dir → "unknown"); the
    // richer progress object drives the staged UI. The progress reader counts
    // fresh artifacts under the SAME artifactsDir the feed serves from.
    const status = await readRunStatus(runId, generateConfig);
    if (status.status === "unknown") return c.json({ error: "run not found" }, 404);
    const progress = await readRunProgress(runId, { ...generateConfig, artifactsDir });
    return c.json(progress);
  });

  app.get("/api/cards", async (c) => {
    const limitRaw = parseInt(c.req.query("limit") ?? "", 10);
    const offsetRaw = parseInt(c.req.query("offset") ?? "", 10);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.isNaN(limitRaw) ? DEFAULT_LIMIT : limitRaw),
    );
    const offset = Math.max(0, Number.isNaN(offsetRaw) ? 0 : offsetRaw);

    // ROUTING SEAM: the published feed shows internal artifacts + APPROVED
    // outward artifacts. Outward-pending drafts are excluded here (they live
    // in GET /api/drafts) so nothing outward-facing publishes before a human
    // approves it. Pagination metadata reflects the PUBLISHED set, not the raw
    // scan — otherwise `total`/`hasMore` would count hidden drafts.
    const all = (await scanArtifacts(artifactsDir)).filter(isPublished);
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
    // Pending outward drafts are not part of the published feed — they are only
    // addressable through the drafts tray, so 404 them here too.
    if (!card || !isPublished(card)) return c.json({ error: "not found" }, 404);
    return c.json(card);
  });

  // ── APPROVALS / DRAFTS tray ───────────────────────────────────────────────
  // The other side of the routing seam: outward artifacts the skills stamped
  // approval_status:"pending" route HERE instead of to the published feed.
  // All three routes ride the same /api/* OpenKey gate as /api/cards (an
  // unauth request → 401 before any of this).
  //
  // Action vocabulary (reuses the existing feedback machinery where it maps):
  //   approve → POST /api/drafts/:id/approve — flips approval_status to
  //             "approved" on disk; the draft then appears in /api/cards.
  //   kill    → POST /api/drafts/:id/kill — a "less"/hide on a draft: logs a
  //             `less` feedback event AND quarantines the dir (moved under
  //             artifacts/.quarantine/ so the scanner no longer sees it —
  //             recoverable, not deleted). Removes it from the tray.
  //   expand  → POST /api/drafts/:id/expand — the "promote" signal: logs a
  //             `promote` feedback event (actual deeper-artifact expansion is a
  //             later orchestration step; here we only record the intent). The
  //             draft stays in the tray pending approve/kill.

  // GET /api/drafts — the pending outward drafts (approval_status:"pending",
  // outward audience). Newest first (scanArtifacts already sorts).
  app.get("/api/drafts", async (c) => {
    const drafts = (await scanArtifacts(artifactsDir)).filter(isPendingDraft);
    return c.json({ drafts, total: drafts.length });
  });

  // POST /api/drafts/:id/approve — set approval_status:"approved" on the
  // artifact.json (atomic write + re-validate). Path-safe id guard up front;
  // the on-disk dir is taken from the SCANNED card's type+slug (never the raw
  // id), then safe-joined under artifactsDir as defence in depth.
  app.post("/api/drafts/:id/approve", async (c) => {
    const id = c.req.param("id");
    if (!isValidArtifactId(id)) return c.json({ error: "invalid draft id" }, 400);

    const card = (await scanArtifacts(artifactsDir)).find((x) => x.id === id);
    if (!card || !isPendingDraft(card)) {
      return c.json({ error: "draft not found" }, 404);
    }

    const dir = safeJoin(artifactsDir, card.type, card.slug);
    if (!dir) return c.json({ error: "forbidden" }, 403);
    const jsonPath = join(dir, "artifact.json");

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(jsonPath, "utf8"));
    } catch {
      return c.json({ error: "draft not found" }, 404);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return c.json({ error: "artifact malformed on disk" }, 422);
    }
    (raw as Record<string, unknown>).approval_status = "approved";

    // Re-validate the full artifact before persisting — never write a record
    // the contract would reject.
    const result = validateArtifact(raw);
    if (!result.ok) {
      return c.json({ error: "artifact failed validation", details: result.errors }, 422);
    }

    // Atomic replace: same sibling-temp + rename() pattern the preferences PUT
    // uses, so no scanner ever observes a partial artifact.json.
    const tmp = `${jsonPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(result.artifact, null, 2) + "\n");
    await rename(tmp, jsonPath);

    return c.json({ ok: true, id, approval_status: "approved" });
  });

  // POST /api/drafts/:id/kill — hide/"less" on a draft. Logs a `less` feedback
  // event (existing machinery) and quarantines the dir so it leaves the tray
  // while staying recoverable.
  app.post("/api/drafts/:id/kill", async (c) => {
    const id = c.req.param("id");
    if (!isValidArtifactId(id)) return c.json({ error: "invalid draft id" }, 400);

    const card = (await scanArtifacts(artifactsDir)).find((x) => x.id === id);
    if (!card || !isPendingDraft(card)) {
      return c.json({ error: "draft not found" }, 404);
    }

    const src = safeJoin(artifactsDir, card.type, card.slug);
    if (!src) return c.json({ error: "forbidden" }, 403);

    // Log the hide as a `less` feedback event (revealed preference) before we
    // move the dir, so the distill-preferences loop still sees the signal.
    await appendEvent(feedbackFile, {
      artifact_id: card.id,
      artifact_type: card.type,
      action: "less",
      ts: new Date().toISOString(),
    });

    // Quarantine, don't delete: move under
    // artifacts/.quarantine/<type>/<slug>__<id> so the scanner (which walks type
    // dirs; a leading-dot dir is just another type that holds no real artifacts of
    // a known type) stops surfacing it but the bytes survive for recovery.
    //
    // The `__<id>` suffix makes quarantine LOSSLESS on a slug collision: two
    // DISTINCT drafts can slugify to the same <type>/<slug> (slug = slugify of a
    // truncated headline), but their artifact ids differ. Without the suffix,
    // killing the second would clobber the first's quarantined copy via the
    // pre-rename rm. The id is already validated by isValidArtifactId (no slashes,
    // dots, or traversal), so it is safe as a path segment. We still rm the exact
    // <slug>__<id> dest first so re-killing the SAME draft is idempotent.
    const quarantineBase = safeJoin(artifactsDir, ".quarantine", card.type);
    if (!quarantineBase) return c.json({ error: "forbidden" }, 403);
    const dest = safeJoin(quarantineBase, `${card.slug}__${id}`);
    if (!dest) return c.json({ error: "forbidden" }, 403);
    try {
      await rm(dest, { recursive: true, force: true }); // clear this draft's prior shadow
      await mkdir(quarantineBase, { recursive: true });
      await rename(src, dest);
    } catch (err) {
      return c.json({ error: `could not quarantine draft: ${String(err)}` }, 500);
    }

    return c.json({ ok: true, id, action: "kill", quarantined: true });
  });

  // POST /api/drafts/:id/expand — the "promote"/expand signal. Records intent
  // via a `promote` feedback event; the draft stays pending (actual expansion
  // is a later orchestration step).
  app.post("/api/drafts/:id/expand", async (c) => {
    const id = c.req.param("id");
    if (!isValidArtifactId(id)) return c.json({ error: "invalid draft id" }, 400);

    const card = (await scanArtifacts(artifactsDir)).find((x) => x.id === id);
    if (!card || !isPendingDraft(card)) {
      return c.json({ error: "draft not found" }, 404);
    }

    await appendEvent(feedbackFile, {
      artifact_id: card.id,
      artifact_type: card.type,
      action: "promote",
      ts: new Date().toISOString(),
    });

    return c.json({ ok: true, id, action: "expand", recorded: true });
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
