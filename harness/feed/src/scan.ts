// Filesystem scanner: artifacts/<type>/<slug>/artifact.json → FeedCard[].
// The filesystem is the source of truth; every scan is a full re-read.
// Malformed or unreadable artifacts are skipped, never fatal.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, FeedCard } from "./types.ts";

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function mediaUrl(type: string, slug: string, file: string): string {
  return `/media/${encodeURIComponent(type)}/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;
}

/**
 * Read one artifact dir. Returns null if there is no parseable artifact.json
 * with the minimum fields a card needs (id + headline).
 */
async function readArtifactDir(
  artifactsDir: string,
  type: string,
  slug: string,
): Promise<FeedCard | null> {
  const dir = join(artifactsDir, type, slug);
  const jsonPath = join(dir, "artifact.json");

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(jsonPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const a = raw as Partial<Artifact> & Record<string, unknown>;
  if (typeof a.id !== "string" || typeof a.headline !== "string") return null;

  // generated_at: fall back to the json file's mtime if absent/unparseable.
  let generatedAt =
    typeof a.generated_at === "string" && !Number.isNaN(Date.parse(a.generated_at))
      ? a.generated_at
      : null;
  if (!generatedAt) {
    try {
      generatedAt = (await stat(jsonPath)).mtime.toISOString();
    } catch {
      generatedAt = new Date(0).toISOString();
    }
  }

  const card: FeedCard = {
    ...a,
    id: a.id,
    headline: a.headline,
    // The directory layout is authoritative for addressing; tolerate a
    // missing/mismatched `type` field by trusting the dir name.
    type: typeof a.type === "string" && a.type.trim() ? a.type : type,
    slug,
    tags: Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : [],
    source_transcripts: Array.isArray(a.source_transcripts)
      ? a.source_transcripts.filter((s): s is string => typeof s === "string")
      : [],
    generated_at: generatedAt,
  };

  // Articles ship their full text as body.md alongside artifact.json;
  // when present it is authoritative for the body.
  try {
    const bodyMd = await readFile(join(dir, "body.md"), "utf8");
    if (bodyMd.trim()) card.body = bodyMd;
  } catch {
    // no body.md — keep whatever artifact.json carried
  }

  // Only emit media URLs for files that actually exist on disk.
  if (typeof a.hero_image === "string" && a.hero_image.trim()) {
    if (await fileExists(join(dir, a.hero_image))) {
      card.hero_image_url = mediaUrl(type, slug, a.hero_image);
    }
  }
  if (typeof a.audio === "string" && a.audio.trim()) {
    if (await fileExists(join(dir, a.audio))) {
      card.audio_url = mediaUrl(type, slug, a.audio);
    }
  }

  return card;
}

/** Scan the artifacts root and return all cards, newest first. */
export async function scanArtifacts(artifactsDir: string): Promise<FeedCard[]> {
  const cards: FeedCard[] = [];
  for (const type of await listDirs(artifactsDir)) {
    // Skip dot-directories at the type level — these are harness bookkeeping,
    // not artifact types. `.quarantine/` holds killed drafts (recoverable but
    // not surfaced); a quarantined artifact.json keeps its real `type` field,
    // so excluding the dir here is what actually removes a killed draft from
    // every scan (feed AND drafts tray).
    if (type.startsWith(".")) continue;
    for (const slug of await listDirs(join(artifactsDir, type))) {
      const card = await readArtifactDir(artifactsDir, type, slug);
      if (card) cards.push(card);
    }
  }
  cards.sort((x, y) => {
    const d = Date.parse(y.generated_at) - Date.parse(x.generated_at);
    if (d !== 0) return d;
    return x.slug.localeCompare(y.slug); // deterministic tiebreak
  });
  return cards;
}
