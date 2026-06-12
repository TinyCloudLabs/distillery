// Synthetic artifact fixtures written to a temp dir for scan/API tests.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Fixture {
  dir: string;
  cleanup: () => Promise<void>;
}

function artifact(overrides: Record<string, unknown>): string {
  return JSON.stringify(
    {
      id: crypto.randomUUID(),
      type: "insight-card",
      headline: "Headline",
      tags: [],
      source_transcripts: ["/tmp/t.md"],
      generated_at: "2026-06-01T00:00:00Z",
      quality: { critic_pass: true, quotes_verified: true },
      ...overrides,
    },
    null,
    2,
  );
}

export async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "distillery-feed-test-"));

  const write = async (type: string, slug: string, json: string | null, media: Record<string, Uint8Array> = {}) => {
    const d = join(dir, type, slug);
    await mkdir(d, { recursive: true });
    if (json !== null) await writeFile(join(d, "artifact.json"), json);
    for (const [name, bytes] of Object.entries(media)) {
      await writeFile(join(d, name), bytes);
    }
  };

  // Newest: podcast with compressed audio (what make-podcast emits: the
  // artifact points at episode.m4a, with episode.wav alongside as the
  // lossless master) + hero
  await write(
    "podcast",
    "newest-podcast",
    artifact({
      id: "pod-1",
      type: "podcast",
      headline: "Newest podcast",
      body: "Show notes with **bold**.",
      audio: "episode.m4a",
      hero_image: "hero.png",
      generated_at: "2026-06-09T12:00:00Z",
      tags: ["audio", "weekly"],
    }),
    {
      "episode.m4a": new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4, 5, 6]),
      "episode.wav": new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      "hero.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    },
  );

  // Middle: insight card whose hero_image is referenced but MISSING on disk
  await write(
    "insight-card",
    "middle-insight",
    artifact({
      id: "ins-1",
      headline: "Middle insight",
      quote: "A quote.",
      attribution: "Someone",
      hero_image: "hero.png", // not written
      generated_at: "2026-06-05T12:00:00Z",
    }),
  );

  // Oldest: article, minimal fields (no tags array, no quality), with a
  // body.md sidecar that must win over the (absent) artifact.json body.
  await write(
    "article",
    "oldest-article",
    `{"id":"art-1","type":"article","headline":"Oldest article","generated_at":"2026-06-01T12:00:00Z","source_transcripts":["/tmp/t.md"]}`,
    { "body.md": new TextEncoder().encode("# Full article\n\nFrom body.md.") },
  );

  // Unknown future type — must still surface as a card
  await write(
    "fever-dream",
    "unknown-type",
    artifact({
      id: "unk-1",
      type: "fever-dream",
      headline: "Unknown type artifact",
      generated_at: "2026-06-03T12:00:00Z",
    }),
  );

  // ROUTING SEAM fixtures (Phase 1a) ----------------------------------------
  // An OUTWARD draft still PENDING approval. Must be EXCLUDED from /api/cards
  // and surface only in /api/drafts.
  await write(
    "social-post",
    "pending-banger",
    artifact({
      id: "draft-pending-1",
      type: "social-post",
      headline: "Pending social post",
      body: "An earned secret, abstracted into one postable line.",
      approval_status: "pending",
      audience: "public",
      platform: "x",
      generated_at: "2026-06-08T12:00:00Z",
    }),
  );

  // An OUTWARD artifact already APPROVED. Must be INCLUDED in /api/cards (it
  // publishes) and ABSENT from /api/drafts.
  await write(
    "investor-update-snippet",
    "approved-snippet",
    artifact({
      id: "approved-snippet-1",
      type: "investor-update-snippet",
      headline: "Approved investor snippet",
      body: "One credible signal, framed for an investor DM.",
      approval_status: "approved",
      audience: "investors",
      generated_at: "2026-06-04T12:00:00Z",
    }),
  );

  // CARDINAL CHECK: an OUTWARD type with NO approval_status field at all. The
  // contract defaults absent-outward to "pending", and so must routing — this
  // MUST be excluded from /api/cards and surface in /api/drafts. A regression
  // that published it would be the worst-case leak (unapproved comms going live).
  await write(
    "social-post",
    "missing-status-banger",
    artifact({
      id: "draft-missing-status-1",
      type: "social-post",
      headline: "Outward draft with no approval_status field",
      body: "No approval_status key at all — must NOT publish.",
      audience: "public",
      generated_at: "2026-06-07T12:00:00Z",
      // NOTE: deliberately NO approval_status key.
    }),
  );

  // CARDINAL CHECK: an OUTWARD type with a BLANK/garbage approval_status. Only
  // the exact string "approved" may publish an outward artifact — a blank, a
  // typo, or any other value MUST route as pending (not published).
  await write(
    "quote-card",
    "blank-status-quote",
    artifact({
      id: "draft-blank-status-1",
      type: "quote-card",
      headline: "Outward draft with a blank approval_status",
      body: "approval_status is an empty string — must NOT publish.",
      approval_status: "",
      audience: "public",
      generated_at: "2026-06-06T12:00:00Z",
    }),
  );

  // Broken JSON — skipped
  await write("insight-card", "broken-json", "{ not json !!!");

  // Dir without artifact.json — skipped
  await write("insight-card", "empty-dir", null, { "stray.png": new Uint8Array([1]) });

  // Stray file at type level — ignored (not a directory)
  await writeFile(join(dir, "insight-card", "stray.txt"), "ignore me");

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
