// publish-lib.ts — the producer's ONLY TinyCloud write surface (§4.3).
//
// Takes a distillery artifact directory (the artifact.json a generation skill
// produced, plus its sibling media files) and publishes it to the hosted
// `applications` space:
//   1. validateArtifact(raw) must pass (reuse artifact.ts — no re-validation here).
//   2. render_type = renderTypeFor(raw.type) (§4.2 pure mapping).
//   3. Media → KV FIRST (Codex non-atomicity fix): base64 the hero/audio bytes,
//      kv.put under media/<id>/…, capture key + sha256 + mime.
//   4. SQL INSERT … ON CONFLICT(id) DO UPDATE into `feed` — typed columns +
//      raw_artifact; immutable fields (id, generated_at, raw_artifact) excluded
//      from the UPDATE set; NEVER INSERT OR REPLACE.
//   5. approval_status = 'approved' written explicitly (per §9.1: V1 is
//      feed-only, no external publish, no human gate — quality is the automated
//      critic + verify-quotes loop).
//   6. Idempotent by id; re-running repairs missing/mismatched KV media then
//      rewrites the consistent SQL pointer.
//
// No graceful fallbacks: a SPACE_NOT_HOSTED / AUTH_UNAUTHORIZED throws the
// TcCliError up so the caller surfaces the §3.4 remediation and BLOCKS.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateArtifact,
  slugify,
  type Artifact,
  type ApprovalStatus,
} from "../../_shared/lib/artifact.ts";
import { renderTypeFor, type RenderType } from "../../_shared/lib/formats.ts";
import {
  sqlExecute,
  kvPutBytes,
  type SqlTarget,
} from "../../_shared/lib/tc.ts";

const FEED_DB = "xyz.tinycloud.artifacts/feed";
const MEDIA_PREFIX = "xyz.tinycloud.artifacts/media";

// §9 override: V1 is feed-only with no human approval gate, and §1.1 says the
// feed holds ONLY approved rows (the viewer reads approved). Everything that
// reaches publish is written approved — this supersedes a generation skill's
// outward=pending default. Applied to both the column and the raw_artifact blob.
const PUBLISHED_APPROVAL_STATUS: ApprovalStatus = "approved";

/** Map a media file extension to its MIME type for the SQL pointer. */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
};

function mimeForFile(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A media asset uploaded to KV (the SQL pointer triple). */
interface MediaPointer {
  key: string;
  sha256: string;
  mime: string;
}

export interface PublishOptions {
  /** Target space (name or URI). Omit to use the profile default space. */
  space?: string;
  /** The agent's sessionDid that publishes (audit; replication identity). */
  publisherDid: string;
}

export interface PublishResult {
  id: string;
  render_type: RenderType;
  slug: string;
  heroKey?: string;
  audioKey?: string;
  sqlChanges: number;
}

/**
 * Upload one media file (sibling of artifact.json) to KV as base64 bytes under
 * media/<id>/<name>, returning the SQL pointer triple. Bytes go to KV FIRST so
 * the SQL pointer it later carries is always backed by real bytes.
 */
async function publishMedia(
  artifactDir: string,
  id: string,
  fileName: string,
  space: string | undefined,
): Promise<MediaPointer> {
  const bytes = new Uint8Array(await readFile(join(artifactDir, fileName)));
  const baseKey = `${MEDIA_PREFIX}/${id}/${fileName}`;
  const { key } = await kvPutBytes(baseKey, bytes, { space });
  return { key, sha256: sha256(bytes), mime: mimeForFile(fileName) };
}

// The mutable columns updated on conflict. Immutable fields (id, generated_at,
// raw_artifact) are intentionally EXCLUDED — a republish never rewrites the
// original generation provenance.
const UPSERT_SQL = `INSERT INTO artifact (
  id, type, render_type, slug, headline, body_md, quote, attribution,
  tags, source_transcripts,
  hero_image_key, hero_image_sha256, hero_image_mime,
  audio_key, audio_sha256, audio_mime, video_url,
  audience, approval_status, platform,
  generation_model, critic_pass, quotes_verified,
  raw_artifact, generated_at, published_at, publisher_did, schema_version
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?, ?
)
ON CONFLICT(id) DO UPDATE SET
  type = excluded.type,
  render_type = excluded.render_type,
  slug = excluded.slug,
  headline = excluded.headline,
  body_md = excluded.body_md,
  quote = excluded.quote,
  attribution = excluded.attribution,
  tags = excluded.tags,
  source_transcripts = excluded.source_transcripts,
  hero_image_key = excluded.hero_image_key,
  hero_image_sha256 = excluded.hero_image_sha256,
  hero_image_mime = excluded.hero_image_mime,
  audio_key = excluded.audio_key,
  audio_sha256 = excluded.audio_sha256,
  audio_mime = excluded.audio_mime,
  video_url = excluded.video_url,
  audience = excluded.audience,
  approval_status = excluded.approval_status,
  platform = excluded.platform,
  generation_model = excluded.generation_model,
  critic_pass = excluded.critic_pass,
  quotes_verified = excluded.quotes_verified,
  published_at = excluded.published_at,
  publisher_did = excluded.publisher_did,
  schema_version = excluded.schema_version`;

/**
 * Publish one validated artifact + its media to the feed. The artifact MUST
 * have already passed validateArtifact (the caller / loadArtifact enforces it);
 * we re-validate defensively and throw on any contract violation.
 */
export async function publishArtifact(
  artifact: Artifact,
  artifactDir: string,
  opts: PublishOptions,
): Promise<PublishResult> {
  const check = validateArtifact(artifact);
  if (!check.ok) {
    throw new Error(
      `refusing to publish contract-invalid artifact:\n  - ${check.errors.join("\n  - ")}`,
    );
  }

  const render_type = renderTypeFor(artifact.type);
  const slug = slugify(artifact.headline);

  // Media first (KV bytes before the SQL pointer).
  let hero: MediaPointer | undefined;
  if (artifact.hero_image) {
    hero = await publishMedia(artifactDir, artifact.id, artifact.hero_image, opts.space);
  }
  let audio: MediaPointer | undefined;
  if (artifact.audio) {
    audio = await publishMedia(artifactDir, artifact.id, artifact.audio, opts.space);
  }

  const target: SqlTarget = { db: FEED_DB, space: opts.space };
  const nowIso = new Date().toISOString();

  // §9 override: V1 is feed-only with no human gate — everything published lands
  // approved. Apply it to BOTH the typed column (what the viewer reads, §1.1)
  // AND the embedded raw_artifact blob so the two can't disagree (a generation
  // skill's outward=pending default is superseded at publish time).
  const publishedArtifact: Artifact = {
    ...artifact,
    approval_status: PUBLISHED_APPROVAL_STATUS,
  };

  const params = [
    artifact.id,
    artifact.type,
    render_type,
    slug,
    artifact.headline,
    artifact.body ?? null,
    artifact.quote ?? null,
    artifact.attribution ?? null,
    JSON.stringify(artifact.tags),
    JSON.stringify(artifact.source_transcripts),
    hero?.key ?? null,
    hero?.sha256 ?? null,
    hero?.mime ?? null,
    audio?.key ?? null,
    audio?.sha256 ?? null,
    audio?.mime ?? null,
    null, // video_url — V1 defers video
    artifact.audience ?? null,
    PUBLISHED_APPROVAL_STATUS, // §9.1: feed-only V1, no DEFAULT, no gate
    artifact.platform ?? null,
    artifact.generation_model ?? null,
    artifact.quality.critic_pass ? 1 : 0,
    artifact.quality.quotes_verified ? 1 : 0,
    JSON.stringify(publishedArtifact),
    artifact.generated_at,
    nowIso,
    opts.publisherDid,
    1, // schema_version
  ];

  const res = await sqlExecute(UPSERT_SQL, target, params);

  return {
    id: artifact.id,
    render_type,
    slug,
    heroKey: hero?.key,
    audioKey: audio?.key,
    sqlChanges: res.changes,
  };
}

/** Read + validate an artifact.json from a directory, throwing on any problem. */
export async function loadArtifact(artifactDir: string): Promise<Artifact> {
  const jsonPath = join(artifactDir, "artifact.json");
  let raw: string;
  try {
    raw = await readFile(jsonPath, "utf8");
  } catch {
    throw new Error(`no artifact.json found at ${jsonPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`artifact.json is not valid JSON: ${(e as Error).message}`);
  }
  const result = validateArtifact(parsed);
  if (!result.ok) {
    throw new Error(
      `artifact.json fails the contract:\n  - ${result.errors.join("\n  - ")}`,
    );
  }
  return result.artifact;
}
