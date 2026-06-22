import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyFullMediaReport, type FullMediaArtifactReport } from "../scripts/full-media-report.ts";

async function artifact(
  root: string,
  kind: FullMediaArtifactReport["kind"],
  media: string[],
): Promise<FullMediaArtifactReport> {
  const dir = join(root, kind, `${kind}-proof`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "artifact.json"), JSON.stringify({ type: kind, slug: `${kind}-proof` }));
  for (const file of media) {
    await writeFile(join(dir, file), file);
  }
  return {
    kind,
    dir,
    jsonPath: join(dir, "artifact.json"),
    media,
  };
}

describe("full media smoke report verification", () => {
  test("accepts local proof artifacts with required media files", async () => {
    const root = await mkdtemp(join(tmpdir(), "full-media-report-"));
    const artifacts = [
      await artifact(root, "clip", ["clip.mp4", "poster.png"]),
      await artifact(root, "podcast", ["episode.wav", "episode.m4a", "script.md"]),
      await artifact(root, "article", ["body.md", "hero.png"]),
    ];

    const verification = verifyFullMediaReport({
      artifacts,
      expectedStages: ["clip", "podcast", "article"],
      publish: { skipped: true },
    });

    expect(verification.ok).toBe(true);
    expect(verification.checks.find((check) => check.name === "publish: skipped")?.ok).toBe(true);
  });

  test("rejects a clip proof without real video media", async () => {
    const root = await mkdtemp(join(tmpdir(), "full-media-report-"));
    const artifacts = [await artifact(root, "clip", ["poster.png"])];

    const verification = verifyFullMediaReport({
      artifacts,
      expectedStages: ["clip"],
      publish: { skipped: true },
    });

    expect(verification.ok).toBe(false);
    expect(verification.checks.find((check) => check.name === "clip: clip video")).toMatchObject({
      ok: false,
    });
  });

  test("requires publish media flags when publish is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "full-media-report-"));
    const artifacts = [
      await artifact(root, "clip", ["clip.mp4", "poster.png"]),
      await artifact(root, "podcast", ["episode.m4a", "script.md"]),
      await artifact(root, "article", ["body.md", "hero.png"]),
    ];

    const verification = verifyFullMediaReport({
      artifacts,
      expectedStages: ["clip", "podcast", "article"],
      publish: {
        held: [],
        published: [
          { type: "clip", slug: "clip-proof", media: { heroImage: true, audio: false, video: true } },
          { type: "podcast", slug: "podcast-proof", media: { heroImage: false, audio: true, video: false } },
          { type: "article", slug: "article-proof", media: { heroImage: true, audio: false, video: false } },
        ],
        media: { heroImages: 2, audio: 1, video: 1 },
      },
    });

    expect(verification.ok).toBe(true);

    const missingVideo = verifyFullMediaReport({
      artifacts,
      expectedStages: ["clip", "podcast", "article"],
      publish: {
        held: [],
        published: [
          { type: "clip", slug: "clip-proof", media: { heroImage: true, audio: false, video: false } },
          { type: "podcast", slug: "podcast-proof", media: { heroImage: false, audio: true, video: false } },
          { type: "article", slug: "article-proof", media: { heroImage: true, audio: false, video: false } },
        ],
        media: { heroImages: 2, audio: 1, video: 0 },
      },
    });

    expect(missingVideo.ok).toBe(false);
    expect(missingVideo.checks.find((check) => check.name === "publish: clip has video")).toMatchObject({
      ok: false,
    });
  });
});
