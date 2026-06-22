import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type FullMediaStage = "clip" | "podcast" | "article";

export interface FullMediaArtifactReport {
  kind: FullMediaStage;
  dir: string;
  jsonPath: string;
  media: string[];
}

export interface FullMediaPublishedReport {
  type: string;
  slug: string;
  media?: {
    heroImage: boolean;
    audio: boolean;
    video: boolean;
  };
}

export interface FullMediaPublishReport {
  skipped?: true;
  published?: FullMediaPublishedReport[];
  held?: Array<{ type: string; slug: string; reason: string }>;
  media?: {
    heroImages: number;
    audio: number;
    video: number;
  };
}

export interface FullMediaVerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface FullMediaVerification {
  ok: boolean;
  expectedStages: FullMediaStage[];
  checks: FullMediaVerificationCheck[];
}

const REQUIRED_MEDIA: Record<FullMediaStage, Array<{ name: string; test: (media: string[]) => boolean }>> = {
  clip: [
    { name: "clip video", test: (media) => media.some((item) => /\.mp4$/i.test(item)) },
    { name: "clip poster", test: (media) => media.includes("poster.png") },
  ],
  podcast: [
    { name: "podcast web audio", test: (media) => media.includes("episode.m4a") },
    { name: "podcast script", test: (media) => media.includes("script.md") },
  ],
  article: [
    { name: "article body", test: (media) => media.includes("body.md") },
    { name: "article hero image", test: (media) => media.includes("hero.png") },
  ],
};

function check(name: string, ok: boolean, detail: string): FullMediaVerificationCheck {
  return { name, ok, detail };
}

function artifactFor(
  artifacts: readonly FullMediaArtifactReport[],
  stage: FullMediaStage,
): FullMediaArtifactReport | undefined {
  return artifacts.find((artifact) => artifact.kind === stage);
}

function publishedFor(
  published: readonly FullMediaPublishedReport[],
  stage: FullMediaStage,
): FullMediaPublishedReport | undefined {
  return published.find((artifact) => artifact.type === stage);
}

export function verifyFullMediaReport({
  artifacts,
  expectedStages,
  publish,
}: {
  artifacts: readonly FullMediaArtifactReport[];
  expectedStages: readonly FullMediaStage[];
  publish: FullMediaPublishReport;
}): FullMediaVerification {
  const checks: FullMediaVerificationCheck[] = [];

  for (const stage of expectedStages) {
    const artifact = artifactFor(artifacts, stage);
    checks.push(check(`${stage}: artifact generated`, Boolean(artifact), artifact?.dir ?? "missing"));
    if (!artifact) continue;

    checks.push(check(`${stage}: artifact.json exists`, existsSync(artifact.jsonPath), artifact.jsonPath));
    for (const mediaName of artifact.media) {
      const path = resolve(artifact.dir, mediaName);
      checks.push(check(`${stage}: media file ${mediaName}`, existsSync(path), path));
    }
    for (const required of REQUIRED_MEDIA[stage]) {
      checks.push(
        check(
          `${stage}: ${required.name}`,
          required.test(artifact.media),
          artifact.media.length > 0 ? artifact.media.join(", ") : "no media listed",
        ),
      );
    }
  }

  if (publish.skipped) {
    checks.push(check("publish: skipped", true, "local-only run"));
  } else {
    const published = publish.published ?? [];
    const held = publish.held ?? [];
    const media = publish.media ?? { heroImages: 0, audio: 0, video: 0 };
    checks.push(check("publish: no held artifacts", held.length === 0, held.length === 0 ? "none" : `${held.length} held`));
    if (expectedStages.includes("clip")) {
      const clip = publishedFor(published, "clip");
      checks.push(check("publish: clip has video", Boolean(clip?.media?.video), clip?.slug ?? "missing"));
    }
    if (expectedStages.includes("podcast")) {
      const podcast = publishedFor(published, "podcast");
      checks.push(check("publish: podcast has audio", Boolean(podcast?.media?.audio), podcast?.slug ?? "missing"));
    }
    if (expectedStages.includes("article")) {
      const article = publishedFor(published, "article");
      checks.push(check("publish: article has hero image", Boolean(article?.media?.heroImage), article?.slug ?? "missing"));
    }
    if (expectedStages.includes("clip")) {
      checks.push(check("publish: aggregate video count", media.video >= 1, String(media.video)));
    }
    if (expectedStages.includes("podcast")) {
      checks.push(check("publish: aggregate audio count", media.audio >= 1, String(media.audio)));
    }
    if (expectedStages.includes("article")) {
      checks.push(check("publish: aggregate hero image count", media.heroImages >= 1, String(media.heroImages)));
    }
  }

  return {
    ok: checks.every((item) => item.ok),
    expectedStages: [...expectedStages],
    checks,
  };
}
