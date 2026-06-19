// The distillery artifact output contract.
//
// Every skill writes artifacts/<type>/<slug>/artifact.json with any media
// files (hero image, audio) alongside it in the same folder, referenced by
// relative path. The shape is modeled on pulse-radio's Card so a feed UI
// (pulse-radio Card pattern) can consume artifacts directly later — that UI
// is a future consumer, not part of this repo.
//
// Plain TS validation (no zod): keeps skills dependency-free so any agent's
// runtime can execute them with just bun.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The format registry (which types exist, outward/internal, miner, labels)
// lives in formats.ts — a browser-safe pure-data module — and is re-exported
// here so script-side consumers keep one import surface.
import { ARTIFACT_TYPES, isOutwardType, type ArtifactType } from "./formats.ts";
export * from "./formats.ts";

export const APPROVAL_STATUSES = ["pending", "approved"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const AUDIENCES = ["public", "investors", "internal"] as const;
export type Audience = (typeof AUDIENCES)[number];

export interface SourceQuote {
  quote: string;
  speaker?: string;
  /** Path (as passed at invocation) of the transcript the quote came from. */
  transcript: string;
  timestamp?: string;
}

/**
 * Quality block — written by the skill's quality loop
 * (extract → triage → draft → critic → verify-quotes).
 */
export interface ArtifactQuality {
  /** The agent ran a critic pass and this artifact survived it. */
  critic_pass: boolean;
  /** Every source_quote was verified verbatim against its transcript. */
  quotes_verified: boolean;
  notes?: string;
}

export interface ArtifactProducerProvenance {
  /** Orchestration surface that published this artifact. */
  pipeline: "artifactory-agent";
  /** Agent run id, when the artifact came from harness/agent. */
  run_id?: string;
  /** TinyCloud space the agent published into under delegation. */
  delegated_space?: string;
  /** CID of the active UCAN delegation used by the agent. */
  delegation_cid?: string;
  /** Delegation expiry visible to operators debugging stale grants. */
  delegation_expires_at?: string;
  /** Development target requested by Smithers/operator runs. */
  target_artifact_type?: ArtifactType;
  /** Rich-media focus requested for this run. */
  media_focus?: "balanced" | "podcast" | "video";
  /** When the agent handed this artifact to tc-publish. */
  published_by_agent_at?: string;
}

export interface Artifact {
  id: string;
  type: ArtifactType;
  headline: string;
  /** Markdown body. Articles put their full text here. */
  body?: string;
  /** Pull-quote surfaced on the card face. */
  quote?: string;
  attribution?: string;
  tags: string[];
  /** Transcript paths this artifact was distilled from (1..n; collections allowed). */
  source_transcripts: string[];
  /** Exact quotes anchoring the artifact's claims to transcript lines. */
  source_quotes?: SourceQuote[];
  /** Media file names relative to the artifact's own folder. */
  hero_image?: string;
  audio?: string;
  video?: string;
  /** Optional externally hosted video fallback; TinyCloud-native clips use video. */
  video_url?: string;
  generated_at: string; // ISO 8601
  generation_model?: string;
  quality: ArtifactQuality;
  /**
   * Human-approval gate state. Optional and backward-compatible: when absent
   * on an OUTWARD type, validateArtifact treats it as "pending" (nothing
   * outward-facing is approved by default). Inward types (insight-card,
   * article, podcast) ignore it.
   */
  approval_status?: ApprovalStatus;
  /** Intended audience for an outward artifact. */
  audience?: Audience;
  /** Target platform when relevant, e.g. "x" / "linkedin". Free-form. */
  platform?: string;
  /** Optional orchestration provenance stamped by the publishing harness. */
  producer?: ArtifactProducerProvenance;
}

export type ValidationResult =
  | { ok: true; artifact: Artifact }
  | { ok: false; errors: string[] };

export function validateArtifact(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["artifact must be an object"] };
  }
  const a = value as Record<string, unknown>;

  const reqString = (key: string) => {
    if (typeof a[key] !== "string" || !(a[key] as string).trim()) {
      errors.push(`${key}: required non-empty string`);
    }
  };
  const optString = (key: string) => {
    if (a[key] !== undefined && typeof a[key] !== "string") {
      errors.push(`${key}: must be a string when present`);
    }
  };

  reqString("id");
  reqString("headline");
  reqString("generated_at");

  if (!ARTIFACT_TYPES.includes(a.type as ArtifactType)) {
    errors.push(`type: must be one of ${ARTIFACT_TYPES.join(", ")}`);
  }
  if (
    typeof a.generated_at === "string" &&
    Number.isNaN(Date.parse(a.generated_at))
  ) {
    errors.push("generated_at: must be an ISO 8601 date string");
  }

  if (!Array.isArray(a.tags) || a.tags.some((t) => typeof t !== "string")) {
    errors.push("tags: required string array (may be empty)");
  }
  if (
    !Array.isArray(a.source_transcripts) ||
    a.source_transcripts.length === 0 ||
    a.source_transcripts.some((s) => typeof s !== "string" || !s.trim())
  ) {
    errors.push("source_transcripts: required non-empty array of paths");
  }

  for (const key of ["body", "quote", "attribution", "hero_image", "audio", "video", "video_url", "generation_model", "platform"]) {
    optString(key);
  }

  if (
    a.approval_status !== undefined &&
    !APPROVAL_STATUSES.includes(a.approval_status as ApprovalStatus)
  ) {
    errors.push(`approval_status: must be one of ${APPROVAL_STATUSES.join(", ")} when present`);
  }
  if (a.audience !== undefined && !AUDIENCES.includes(a.audience as Audience)) {
    errors.push(`audience: must be one of ${AUDIENCES.join(", ")} when present`);
  }

  if (a.source_quotes !== undefined) {
    if (!Array.isArray(a.source_quotes)) {
      errors.push("source_quotes: must be an array when present");
    } else {
      a.source_quotes.forEach((q, i) => {
        const sq = q as Record<string, unknown>;
        if (typeof sq?.quote !== "string" || !sq.quote.trim())
          errors.push(`source_quotes[${i}].quote: required non-empty string`);
        if (typeof sq?.transcript !== "string" || !sq.transcript.trim())
          errors.push(`source_quotes[${i}].transcript: required non-empty string`);
      });
    }
  }

  const q = a.quality as Record<string, unknown> | undefined;
  if (typeof q !== "object" || q === null) {
    errors.push("quality: required object {critic_pass, quotes_verified, notes?}");
  } else {
    if (typeof q.critic_pass !== "boolean")
      errors.push("quality.critic_pass: required boolean");
    if (typeof q.quotes_verified !== "boolean")
      errors.push("quality.quotes_verified: required boolean");
    if (q.notes !== undefined && typeof q.notes !== "string")
      errors.push("quality.notes: must be a string when present");
  }

  if (a.producer !== undefined) {
    if (typeof a.producer !== "object" || a.producer === null || Array.isArray(a.producer)) {
      errors.push("producer: must be an object when present");
    } else {
      const p = a.producer as Record<string, unknown>;
      if (p.pipeline !== "artifactory-agent") {
        errors.push('producer.pipeline: must be "artifactory-agent" when producer is present');
      }
      for (const key of [
        "run_id",
        "delegated_space",
        "delegation_cid",
        "delegation_expires_at",
        "published_by_agent_at",
      ]) {
        if (p[key] !== undefined && typeof p[key] !== "string") {
          errors.push(`producer.${key}: must be a string when present`);
        }
      }
      if (
        p.target_artifact_type !== undefined &&
        !ARTIFACT_TYPES.includes(p.target_artifact_type as ArtifactType)
      ) {
        errors.push(`producer.target_artifact_type: must be one of ${ARTIFACT_TYPES.join(", ")}`);
      }
      if (
        p.media_focus !== undefined &&
        !["balanced", "podcast", "video"].includes(p.media_focus as string)
      ) {
        errors.push("producer.media_focus: must be one of balanced, podcast, video");
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const artifact = value as Artifact;
  // Default the approval gate to "pending" for outward-facing types when the
  // field is absent — nothing outward-facing is approved by default. Inward
  // types are left untouched (the field stays undefined / ignored).
  if (artifact.approval_status === undefined && isOutwardType(artifact.type)) {
    artifact.approval_status = "pending";
  }
  return { ok: true, artifact };
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "untitled"
  );
}

export function newArtifactId(): string {
  return crypto.randomUUID();
}

export interface WriteArtifactOptions {
  /** Output root; defaults to ./artifacts under the current working dir. */
  outDir?: string;
  /** Media to write alongside artifact.json, keyed by file name. */
  media?: Record<string, Uint8Array>;
}

export interface WrittenArtifact {
  dir: string;
  jsonPath: string;
}

/**
 * Validate then persist an artifact to <outDir>/<type>/<slug>/artifact.json,
 * writing any media files into the same folder. Throws on invalid artifacts.
 */
export async function writeArtifact(
  artifact: Artifact,
  opts: WriteArtifactOptions = {},
): Promise<WrittenArtifact> {
  const result = validateArtifact(artifact);
  if (!result.ok) {
    throw new Error(`Invalid artifact:\n  - ${result.errors.join("\n  - ")}`);
  }
  const outDir = opts.outDir ?? join(process.cwd(), "artifacts");
  const dir = join(outDir, artifact.type, slugify(artifact.headline));
  await mkdir(dir, { recursive: true });

  for (const [name, bytes] of Object.entries(opts.media ?? {})) {
    await writeFile(join(dir, name), bytes);
  }
  const jsonPath = join(dir, "artifact.json");
  await writeFile(jsonPath, JSON.stringify(artifact, null, 2) + "\n");
  return { dir, jsonPath };
}
