import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyListenReadResult } from "../harness/agent/src/listen-read-outcome.ts";
import { canReclaimRunLock, reconcileStaleRun, summarizeRunLock } from "../harness/agent/src/runs.ts";
import {
  boundedProcessOutput,
  buildGenerationArgs,
  createPipelineContext,
  formatMediaSummary,
  sanitizeArtifactMediaForPublish,
  shouldPublishArtifact,
  summarizeArtifactRoutes,
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

describe("agent runner generation prompt", () => {
  function withMediaEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
    const keys = ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "FAL_KEY", "AGENT_ENABLE_VIDEO"];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test("prioritizes a publishable Feed artifact before approval-held drafts", () => {
    const args = withMediaEnv({ GEMINI_API_KEY: "test-key" }, () =>
      buildGenerationArgs("/tmp/corpus", "/tmp/artifacts", ["/tmp/corpus/demo.md"]),
    );
    const systemPrompt = String(args[args.indexOf("--system-prompt") + 1]);
    const userPrompt = String(args[args.indexOf("-p") + 1]);

    const articleIndex = systemPrompt.indexOf("PUBLISHABLE FEED ARTIFACTS FIRST");
    const draftIndex = systemPrompt.indexOf("OPTIONAL OUTWARD DRAFT");

    expect(articleIndex).toBeGreaterThan(-1);
    expect(draftIndex).toBeGreaterThan(-1);
    expect(articleIndex).toBeLessThan(draftIndex);
    expect(systemPrompt).toContain("target publishable Feed artifacts: 3");
    expect(systemPrompt).toContain("PUBLISHABLE FEED ARTIFACTS FIRST: aim for up to 3");
    expect(systemPrompt).toContain("hot-take");
    expect(systemPrompt).toContain("write-article");
    expect(systemPrompt).toContain("make-podcast");
    expect(systemPrompt).toContain("synthesize.ts");
    expect(systemPrompt).toContain("--audio");
    expect(systemPrompt).toContain("extract-insights");
    expect(systemPrompt).toContain("person-brief");
    expect(systemPrompt).toContain("HERO IMAGES");
    expect(systemPrompt).toContain("Social posts are held for approval and will not fill Feed");
    expect(userPrompt).toContain("up to 3 publishable internal artifacts for the Feed");
    expect(userPrompt).toContain("optionally one approval-held social-post draft");
  });

  test("asks for real hero images and podcasts only when a Gemini provider is configured", () => {
    const skippedArgs = withMediaEnv({}, () =>
      buildGenerationArgs("/tmp/corpus", "/tmp/artifacts", ["/tmp/corpus/demo.md"]),
    );
    const skipped = String(skippedArgs[skippedArgs.indexOf("--system-prompt") + 1]);
    expect(skipped).toContain("HERO IMAGES SKIPPED");
    expect(skipped).toContain("PODCAST AUDIO SKIPPED");
    expect(skipped).not.toContain("synthesize.ts");

    const enabledArgs = withMediaEnv({ GEMINI_API_KEY: "test-key" }, () =>
      buildGenerationArgs("/tmp/corpus", "/tmp/artifacts", ["/tmp/corpus/demo.md"]),
    );
    const enabled = String(enabledArgs[enabledArgs.indexOf("--system-prompt") + 1]);
    expect(enabled).toContain("HERO IMAGES");
    expect(enabled).toContain("skills/illustrate-card/SKILL.md");
    expect(enabled).toContain("skills/illustrate-card/scripts/illustrate.ts");
    expect(enabled).toContain("make-podcast");
    expect(enabled).toContain("skills/make-podcast/SKILL.md");
    expect(enabled).toContain("synthesize.ts");
  });
});

describe("agent runner generation visibility", () => {
  test("summarizes publishable and held artifact routes for progress logs", () => {
    expect(
      summarizeArtifactRoutes([
        { type: "article", slug: "visible", publish: true },
        { type: "social-post", slug: "held", publish: false },
      ]),
    ).toBe("2 artifact(s) 1 publishable [article/visible] 1 held [social-post/held]");
  });

  test("summarizes published media presence for run logs and clients", () => {
    expect(
      formatMediaSummary({
        type: "podcast",
        slug: "episode",
        media: { heroImage: true, audio: true, video: false },
      }),
    ).toBe(" (image, audio)");
    expect(
      formatMediaSummary({
        type: "article",
        slug: "plain",
        media: { heroImage: false, audio: false, video: false },
      }),
    ).toBe(" (no media)");
    expect(formatMediaSummary({ type: "article", slug: "old-shape" })).toBe("");
  });

  test("bounds child process output tails for run logs", () => {
    expect(boundedProcessOutput("stdout", "")).toBeNull();
    expect(boundedProcessOutput("stdout", "abcdef", 3)).toBe("stdout tail: ...def");
  });
});

describe("agent run stale-state reconciliation", () => {
  function runState(overrides: Partial<RunState> = {}): RunState {
    return {
      run_id: "run-1781811131857-3r6pbz",
      status: "running",
      published: [],
      startedAt: Date.parse("2026-06-18T19:32:11.857Z"),
      log: ["2026-06-18T19:32:16.704Z generate: distilling publishable feed artifact from the corpus"],
      ...overrides,
    };
  }

  test("marks abandoned running runs as error after the stale threshold", () => {
    const now = Date.parse("2026-06-18T19:53:16.704Z");
    const { state, changed } = reconcileStaleRun(runState(), now, 20 * 60 * 1000);

    expect(changed).toBe(true);
    expect(state.status).toBe("error");
    expect(state.finishedAt).toBe(now);
    expect(state.error).toContain("became stale");
    expect(state.log.at(-1)).toContain("ERROR: Run became stale");
  });

  test("keeps running runs with recent heartbeat progress", () => {
    const now = Date.parse("2026-06-18T19:40:16.704Z");
    const { state, changed } = reconcileStaleRun(
      runState({
        log: [
          "2026-06-18T19:32:16.704Z generate: distilling publishable feed artifact from the corpus",
          "2026-06-18T19:39:56.704Z generate: still running (1 artifact(s) 1 publishable [article/demo] 0 held)",
        ],
      }),
      now,
      20 * 60 * 1000,
    );

    expect(changed).toBe(false);
    expect(state.status).toBe("running");
  });

  test("keeps running runs with recent non-generate stage progress", () => {
    const now = Date.parse("2026-06-18T19:40:16.704Z");
    const { state, changed } = reconcileStaleRun(
      runState({
        log: [
          "2026-06-18T19:32:16.704Z publish: publishing article/demo",
          "2026-06-18T19:39:56.704Z publish: still publishing article/demo",
        ],
      }),
      now,
      20 * 60 * 1000,
    );

    expect(changed).toBe(false);
    expect(state.status).toBe("running");
  });
});

describe("agent run lock reclamation", () => {
  test("keeps unknown active locks before the stale threshold", () => {
    expect(
      canReclaimRunLock(
        {
          run_id: "missing-run-state",
          owner: "unit-test",
          pid: 123,
          acquiredAt: 1_000,
        },
        1_000 + 19 * 60 * 1000,
        20 * 60 * 1000,
      ),
    ).toBe(false);
  });

  test("reclaims unknown locks after the stale threshold", () => {
    expect(
      canReclaimRunLock(
        {
          run_id: "missing-run-state",
          owner: "unit-test",
          pid: 123,
          acquiredAt: 1_000,
        },
        1_000 + 21 * 60 * 1000,
        20 * 60 * 1000,
      ),
    ).toBe(true);
  });

  test("summarizes lock age and reclaimability for visibility surfaces", () => {
    expect(
      summarizeRunLock(
        {
          run_id: "missing-run-state",
          owner: "smithers-agent-run",
          pid: 123,
          acquiredAt: 1_000,
        },
        1_000 + 21 * 60 * 1000,
      ),
    ).toEqual({
      run_id: "missing-run-state",
      owner: "smithers-agent-run",
      pid: 123,
      acquiredAt: 1_000,
      ageMs: 21 * 60 * 1000,
      reclaimable: true,
    });
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
