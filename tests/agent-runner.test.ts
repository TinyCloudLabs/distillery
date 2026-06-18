import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyListenReadResult } from "../harness/agent/src/listen-read-outcome.ts";
import {
  createPipelineContext,
  sanitizeArtifactMediaForPublish,
  shouldPublishArtifact,
  type RunState,
} from "../harness/agent/src/runner.ts";
import type { ActiveDelegation } from "../harness/agent/src/session.ts";

describe("agent runner listen-read classification", () => {
  test("explicit no-transcripts output is a valid empty Listen run", () => {
    expect(
      classifyListenReadResult({
        code: 1,
        stdout: "",
        stderr:
          "No non-empty transcripts found. Nothing written. (Check the conversation count / space.)",
      }),
    ).toEqual({
      kind: "empty",
      message: "No non-empty transcripts found.",
    });
  });

  test("AUTH_UNAUTHORIZED is surfaced as an error, not an empty run", () => {
    const result = classifyListenReadResult({
      code: 1,
      stdout: "",
      stderr: JSON.stringify({
        error: {
          code: "AUTH_UNAUTHORIZED",
          message:
            "SQL query failed: 401 - Unauthorized Action: tinycloud.sql/read",
        },
      }),
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("AUTH_UNAUTHORIZED");
      expect(result.message).toContain("Unauthorized Action");
    }
  });

  test("unexpected zero-output success is ok at process level", () => {
    expect(classifyListenReadResult({ code: 0, stdout: "", stderr: "" })).toEqual({
      kind: "ok",
    });
  });
});

describe("agent runner artifact routing", () => {
  test("holds public pending social posts for approval instead of publishing", () => {
    expect(
      shouldPublishArtifact({
        type: "social-post",
        audience: "public",
        approval_status: "pending",
      }),
    ).toEqual({
      publish: false,
      reason: "audience=public requires approval surface",
    });
  });

  test("publishes internal feed artifacts", () => {
    expect(
      shouldPublishArtifact({
        type: "article",
      }),
    ).toEqual({ publish: true });
  });

  test("allows internal person briefs through the feed path", () => {
    expect(
      shouldPublishArtifact({
        type: "person-brief",
        audience: "internal",
        approval_status: "pending",
      }),
    ).toEqual({ publish: true });
  });
});

describe("agent runner pipeline context", () => {
  test("derives per-run scratch paths and records progress logs", () => {
    const state: RunState = {
      run_id: "run-1781811113187-abc123",
      status: "queued",
      published: [],
      startedAt: Date.now(),
      log: [],
    };
    const progress: RunState[] = [];
    const active = {
      spaceId: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
      delegationCid: "bafy-test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      grantedAt: Date.now(),
      delegation: {},
    };

    const ctx = createPipelineContext(active as unknown as ActiveDelegation, state, (next) => {
      progress.push({ ...next, published: [...next.published], log: [...next.log] });
    });
    ctx.step("unit-test stage marker");

    expect(ctx.space).toBe(active.spaceId);
    expect(ctx.corpusDir.endsWith("/run-1781811113187-abc123/corpus")).toBe(true);
    expect(ctx.artifactsDir.endsWith("/run-1781811113187-abc123/artifacts")).toBe(true);
    expect(state.log[0]).toContain("unit-test stage marker");
    expect(progress).toHaveLength(1);
  });
});

describe("agent runner artifact media preflight", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempArtifactDir(artifact: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), "distillery-agent-media-"));
    dirs.push(dir);
    await writeFile(join(dir, "artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`);
    return dir;
  }

  async function readArtifact(dir: string) {
    return JSON.parse(await readFile(join(dir, "artifact.json"), "utf8")) as Record<
      string,
      unknown
    >;
  }

  test("strips a missing hero_image before publish", async () => {
    const artifact = { type: "article", slug: "missing", hero_image: "hero.png" };
    const dir = await tempArtifactDir(artifact);

    const warnings = await sanitizeArtifactMediaForPublish(dir, artifact);

    expect(warnings).toEqual(['hero_image stripped: missing file "hero.png"']);
    expect((await readArtifact(dir)).hero_image).toBeUndefined();
  });

  test("strips unsafe hero_image paths before publish", async () => {
    const artifact = { type: "article", slug: "unsafe", hero_image: "../hero.png" };
    const dir = await tempArtifactDir(artifact);

    const warnings = await sanitizeArtifactMediaForPublish(dir, artifact);

    expect(warnings).toEqual(['hero_image stripped: unsafe media file name "../hero.png"']);
    expect((await readArtifact(dir)).hero_image).toBeUndefined();
  });

  test("keeps a valid local PNG hero_image", async () => {
    const artifact = { type: "article", slug: "valid", hero_image: "hero.png" };
    const dir = await tempArtifactDir(artifact);
    await writeFile(
      join(dir, "hero.png"),
      new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      ]),
    );

    const warnings = await sanitizeArtifactMediaForPublish(dir, artifact);

    expect(warnings).toEqual([]);
    expect((await readArtifact(dir)).hero_image).toBe("hero.png");
  });
});
