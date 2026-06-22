import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyListenReadResult } from "../harness/agent/src/listen-read-outcome.ts";
import {
  canReclaimRunLock,
  reconcileStaleRun,
  summarizePublishedMedia,
  summarizeRunLock,
} from "../harness/agent/src/runs.ts";
import {
  boundedProcessOutput,
  buildArtifactMixPlanStep,
  buildGenerationArgs,
  buildInteractionBackpressureStep,
  buildListenCandidateArgs,
  buildListenReadArgs,
  buildMediaFocusStep,
  buildTargetArtifactTypeStep,
  createPipelineContext,
  formatArtifactTreeSummary,
  formatDuration,
  formatHeartbeatInfo,
  formatMediaSummary,
  preflightArtifactMediaForPublish,
  publishedRefFromPublishStdout,
  nextListenReadOffset,
  parseListenCandidateList,
  parseListenReadCursor,
  runPublishStage,
  sanitizeArtifactMediaForPublish,
  shouldPublishArtifact,
  selectCorpusCandidates,
  stampArtifactRunProvenance,
  summarizeInteractionBackpressure,
  type PipelineContext,
  summarizeArtifactTree,
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

  test("builds listen-read args with an explicit offset", () => {
    expect(buildListenReadArgs("/tmp/corpus", 5, "space-id", 12, ["c1", "c2"])).toEqual([
      "skills/tc-listen-read/scripts/listen-read.ts",
      "--out",
      "/tmp/corpus",
      "--count",
      "5",
      "--offset",
      "12",
      "--space",
      "space-id",
      "--owner-space",
      "space-id",
      "--conversation-id",
      "c1",
      "--conversation-id",
      "c2",
    ]);
  });

  test("builds candidate listing args for corpus planning", () => {
    expect(buildListenCandidateArgs(25, "space-id", 10)).toEqual([
      "skills/tc-listen-read/scripts/listen-read.ts",
      "--list-candidates",
      "--count",
      "25",
      "--offset",
      "10",
      "--space",
      "space-id",
      "--owner-space",
      "space-id",
    ]);
  });

  test("parses and advances the listen-read cursor defensively", () => {
    expect(parseListenReadCursor(JSON.stringify({ nextOffset: 10 }))).toBe(10);
    expect(parseListenReadCursor(JSON.stringify({ nextOffset: -1 }))).toBe(0);
    expect(parseListenReadCursor("not json")).toBe(0);
    expect(nextListenReadOffset(10, 5)).toBe(15);
    expect(nextListenReadOffset(-1, 5)).toBe(5);
  });

  test("parses candidate list output defensively", () => {
    const parsed = parseListenCandidateList(JSON.stringify({
      count: 3,
      offset: 5,
      candidates: [
        { id: "a", title: "Alpha", transcript_storage: "kv" },
        { id: "b", title: "Beta", transcript_storage: "inline" },
        { id: "bad", title: "Bad", transcript_storage: "unknown" },
      ],
    }));

    expect(parsed.count).toBe(3);
    expect(parsed.offset).toBe(5);
    expect(parsed.candidates.map((candidate) => candidate.id)).toEqual(["a", "b"]);
  });

  test("selects fresh transcript-backed candidates before recent fallbacks", () => {
    const selected = selectCorpusCandidates(
      [
        { id: "recent", title: "Recent", transcript_storage: "kv" },
        { id: "empty", title: "Empty", transcript_storage: "none" },
        { id: "fresh", title: "Fresh", transcript_storage: "inline" },
        { id: "fresh-2", title: "Fresh 2", transcript_storage: "kv" },
      ],
      new Set(["recent"]),
      2,
    );

    expect(selected.skippedRecent).toBe(1);
    expect(selected.selected.map((entry) => entry.id)).toEqual(["fresh", "fresh-2"]);

    const fallback = selectCorpusCandidates(
      [
        { id: "recent", title: "Recent", transcript_storage: "kv" },
        { id: "fresh", title: "Fresh", transcript_storage: "inline" },
      ],
      new Set(["recent"]),
      3,
    );
    expect(fallback.selected.map((entry) => entry.id)).toEqual(["fresh", "recent"]);
    expect(fallback.selected[1]?.reason).toContain("recent fallback");
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
  const providers = (
    geminiEnabled: boolean,
    videoEnabled: boolean,
    falVideoEnabled = videoEnabled,
    veoVideoEnabled = false,
  ) => ({ geminiEnabled, videoEnabled, falVideoEnabled, veoVideoEnabled });

  function withMediaEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
    const keys = [
      "GOOGLE_AI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "FAL_KEY",
      "AGENT_ENABLE_VIDEO",
      "DEV_DISTILLERY_ENV",
    ];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.DEV_DISTILLERY_ENV = "/tmp/distillery-agent-runner-test-missing.env";
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
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--mcp-config");
    expect(args).toContain('{"mcpServers":{}}');
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

  test("reads allowlisted media provider keys from the development env file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "distillery-agent-env-"));
    const envPath = join(dir, ".env");
    await writeFile(
      envPath,
      [
        "GEMINI_API_KEY=gemini-from-dev-env",
        "FAL_KEY=fal-from-dev-env",
        "AGENT_ENABLE_VIDEO=1",
        "TC_SECRET_SHOULD_NOT_LEAK=forbidden",
      ].join("\n"),
    );
    try {
      const args = withMediaEnv({ DEV_DISTILLERY_ENV: envPath }, () =>
        buildGenerationArgs("/tmp/corpus", "/tmp/artifacts", ["/tmp/corpus/demo.md"]),
      );
      const systemPrompt = String(args[args.indexOf("--system-prompt") + 1]);
      expect(systemPrompt).toContain("HERO IMAGES");
      expect(systemPrompt).toContain("ARTIFACT MIX PLAN");
      expect(systemPrompt).toContain("VIDEO SLOT: reserve one publishable slot for a clip attempt");
      expect(systemPrompt).toContain("EXPECTED CLIP SLOT");
      expect(systemPrompt).not.toContain("VIDEO SKIPPED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("can bias a development run toward proving podcast media", () => {
    expect(buildMediaFocusStep("podcast", providers(true, false)).join("\n"))
      .toContain("trying to prove the podcast");
    expect(buildMediaFocusStep("podcast", providers(true, false)).join("\n"))
      .toContain("first publishable artifact");
    expect(buildMediaFocusStep("podcast", providers(false, false)).join("\n"))
      .toContain("no Gemini provider is configured");
  });

  test("can bias a development run toward proving video media when enabled", () => {
    expect(buildMediaFocusStep("video", providers(true, true, false, true)).join("\n"))
      .toContain("trying to prove the video");
    expect(buildMediaFocusStep("video", providers(true, true, false, true)).join("\n"))
      .toContain("make-cheap-video");
    expect(buildMediaFocusStep("video", providers(true, false)).join("\n"))
      .toContain("AGENT_ENABLE_VIDEO=1 plus a");
    expect(buildMediaFocusStep("balanced", providers(true, true, false, true)).join("\n"))
      .toContain("Pick the best formats");
  });

  test("reserves a video slot in the artifact mix plan for auto runs when video is enabled", () => {
    const plan = buildArtifactMixPlanStep({
      targetArtifacts: 3,
      artifactsDir: "/tmp/artifacts",
      mediaFocus: "balanced",
      providers: providers(true, true, false, true),
    }).join("\n");

    expect(plan).toContain("skills/plan-feed-mix/SKILL.md");
    expect(plan).toContain("/tmp/artifacts/mix-plan.md");
    expect(plan).toContain("VIDEO SLOT: reserve one publishable slot for a clip attempt");
    expect(plan).toContain("Do not silently skip");
    expect(plan).toContain("feed-shape, diversity checks, backpressure");
    expect(plan).toContain("one compact artifact, one developed artifact, and");
    expect(plan).toContain("one rich-media artifact");
    expect(plan).toContain("regression-to-mean guard");
    expect(plan).toContain("one transcript, source, theme, or artifact family");
  });

  test("does not reserve video when another explicit target takes priority", () => {
    const plan = buildArtifactMixPlanStep({
      targetArtifacts: 3,
      artifactsDir: "/tmp/artifacts",
      mediaFocus: "balanced",
      providers: providers(true, true, false, true),
      targetArtifactType: "article",
    }).join("\n");

    expect(plan).toContain("VIDEO SLOT: video is available, but this run has a different explicit");
    expect(plan).toContain("use remaining slots");
    expect(plan).toContain("diversify the feed");
    expect(plan).not.toContain("reserve one publishable slot for a clip attempt");
  });

  test("can target one artifact type without turning it into a quota", () => {
    const podcast = buildTargetArtifactTypeStep("podcast").join("\n");
    expect(podcast).toContain("ARTIFACT TARGET: podcast");
    expect(podcast).toContain("quality still wins");
    expect(podcast).toContain("do NOT create a weak");
    expect(podcast).toContain("Try `make-podcast` first");

    const social = buildTargetArtifactTypeStep("social-post").join("\n");
    expect(social).toContain("approval-held outward draft");
    expect(social).toMatch(/First satisfy the publishable feed\s+set/);

    const quote = buildTargetArtifactTypeStep("quote-card").join("\n");
    expect(quote).toContain("already-approved artifact");
    expect(quote).toContain("do not fabricate one");
  });

  test("threads target artifact type into the generation prompt", () => {
    const args = withMediaEnv({ GEMINI_API_KEY: "test-key" }, () =>
      buildGenerationArgs("/tmp/corpus", "/tmp/artifacts", ["/tmp/corpus/demo.md"], {
        targetArtifactType: "digest",
      }),
    );
    const systemPrompt = String(args[args.indexOf("--system-prompt") + 1]);
    expect(systemPrompt).toContain("ARTIFACT TARGET: digest");
    expect(systemPrompt).toContain("Try `write-digest` first");
    expect(systemPrompt).toContain("quality still wins");
  });

  test("summarizes Feed interactions as weak backpressure, not hard preferences", () => {
    const summary = summarizeInteractionBackpressure([
      {
        artifact_id: "article-1",
        artifact_type: "article",
        action: "more",
        note: null,
        recorded_at: "2026-06-19T18:00:00.000Z",
      },
      {
        artifact_id: "article-2",
        artifact_type: "article",
        action: "save",
        note: "useful framing",
        recorded_at: "2026-06-19T18:01:00.000Z",
      },
      {
        artifact_id: "podcast-1",
        artifact_type: "podcast",
        action: "less",
        note: "too thin",
        recorded_at: "2026-06-19T18:02:00.000Z",
      },
    ]);

    expect(summary.status).toBe("ready");
    expect(summary.lines.join("\n")).toContain("more=1");
    expect(summary.lines.join("\n")).toContain("save=1");
    expect(summary.lines.join("\n")).toContain("less=1");
    expect(summary.lines.join("\n")).toContain("Reader note: save on article/article-2");

    const prompt = buildInteractionBackpressureStep(summary).join("\n");
    expect(prompt).toContain("weak prior");
    expect(prompt).toContain("not a settled preference model");
    expect(prompt).toContain("Preserve exploration");
    expect(prompt).toContain("wrong` as an accuracy warning");
  });

  test("threads reader interaction backpressure into the generation prompt", () => {
    const args = withMediaEnv({ GEMINI_API_KEY: "test-key" }, () =>
      buildGenerationArgs("/tmp/corpus", "/tmp/artifacts", ["/tmp/corpus/demo.md"], {
        interactionBackpressure: {
          status: "ready",
          lines: ["Recent interactions: 2 event(s); more=1, less=1."],
        },
      }),
    );
    const systemPrompt = String(args[args.indexOf("--system-prompt") + 1]);
    expect(systemPrompt).toContain("READER BACKPRESSURE");
    expect(systemPrompt).toContain("Recent interactions: 2 event(s); more=1, less=1.");
    expect(systemPrompt).toContain("Preserve exploration");
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

  test("uses tc-publish JSON output as the source of truth for published media", () => {
    const ref = publishedRefFromPublishStdout(
      JSON.stringify({
        id: "artifact-1",
        type: "article",
        render_type: "article",
        slug: "with-image",
        heroKey: "xyz.tinycloud.artifacts/media/artifact-1/hero.png.b64",
        audioKey: null,
        videoKey: null,
        sqlChanges: 1,
      }),
      { type: "article", slug: "fallback" },
    );

    expect(ref).toEqual({
      type: "article",
      slug: "with-image",
      media: { heroImage: true, audio: false, video: false },
    });
  });

  test("falls back to local artifact refs when publish output is not JSON", () => {
    const fallback = {
      type: "article",
      slug: "local-ref",
      media: { heroImage: true, audio: false, video: false },
    };

    expect(publishedRefFromPublishStdout("Published artifact-1", fallback)).toBe(fallback);
  });

  test("aggregates run-level media counts from published artifacts", () => {
    expect(
      summarizePublishedMedia([
        { type: "article", slug: "a", media: { heroImage: true, audio: false, video: false } },
        { type: "podcast", slug: "b", media: { heroImage: true, audio: true, video: false } },
        { type: "clip", slug: "c", media: { heroImage: true, audio: false, video: true } },
        { type: "article", slug: "old-shape" },
      ]),
    ).toEqual({ heroImages: 3, audio: 1, video: 1 });
    expect(summarizePublishedMedia(undefined)).toEqual({ heroImages: 0, audio: 0, video: 0 });
  });

  test("bounds child process output tails for run logs", () => {
    expect(boundedProcessOutput("stdout", "")).toBeNull();
    expect(boundedProcessOutput("stdout", "abcdef", 3)).toBe("stdout tail: ...def");
  });

  test("formats generate heartbeat process diagnostics", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(
      formatHeartbeatInfo({
        pid: 1234,
        startedAt: 1_000,
        elapsedMs: 125_000,
        stdoutBytes: 42,
        stderrBytes: 7,
      }),
    ).toBe("pid=1234 elapsed=2m05s stdout=42B stderr=7B");
  });

  test("summarizes artifact file progress for generate heartbeats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "distillery-agent-tree-"));
    try {
      await mkdir(join(dir, "article", "demo"), { recursive: true });
      await writeFile(join(dir, "article", "demo", "artifact.json"), "{}");
      await writeFile(join(dir, "article", "demo", "hero.png"), "fake-image");

      const summary = await summarizeArtifactTree(dir, Date.now());
      expect(summary).toContain("files=2");
      expect(summary).toContain("bytes=12");
      expect(summary).toContain("latest=");
      expect(summary).toContain("latest_age=");

      expect(
        formatArtifactTreeSummary({
          fileCount: 0,
          totalBytes: 0,
        }),
      ).toBe("files=0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  test("stamps agent run provenance before publish", async () => {
    const artifact = { type: "article", slug: "provenance" };
    const dir = await tempArtifactDir(artifact);
    const state: RunState = {
      run_id: "run-1781811131857-prv001",
      status: "running",
      published: [],
      startedAt: Date.now(),
      log: [],
    };
    const ctx: PipelineContext = {
      active: {
        spaceId: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
        delegationCid: "bafy-delegation",
        expiresAt: "2026-06-19T22:00:00.000Z",
      } as unknown as ActiveDelegation,
      state,
      onProgress: () => {},
      space: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
      corpusDir: join(dir, "corpus"),
      artifactsDir: join(dir, "artifacts"),
      targetArtifactType: "article",
      step: () => {},
    };

    await stampArtifactRunProvenance(dir, ctx);

    const written = await readArtifact(dir);
    expect(written.producer).toMatchObject({
      pipeline: "artifactory-agent",
      run_id: "run-1781811131857-prv001",
      delegated_space: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
      delegation_cid: "bafy-delegation",
      delegation_expires_at: "2026-06-19T22:00:00.000Z",
      target_artifact_type: "article",
      media_focus: "balanced",
    });
    expect(typeof (written.producer as Record<string, unknown>).published_by_agent_at).toBe(
      "string",
    );
  });

  test("strips missing optional audio before publish", async () => {
    const artifact = { type: "article", slug: "optional-audio", audio: "missing.m4a" };
    const dir = await tempArtifactDir(artifact);

    const result = await preflightArtifactMediaForPublish(dir, artifact);

    expect(result.blockReason).toBeUndefined();
    expect(result.warnings).toEqual(['audio stripped: missing file "missing.m4a"']);
    expect((await readArtifact(dir)).audio).toBeUndefined();
  });

  test("blocks a podcast without valid audio instead of publishing a shell", async () => {
    const artifact = { type: "podcast", slug: "fake-podcast", audio: "missing.m4a" };
    const dir = await tempArtifactDir(artifact);

    const result = await preflightArtifactMediaForPublish(dir, artifact);

    expect(result.blockReason).toBe('audio required for podcast but missing file "missing.m4a"');
    expect(result.warnings).toEqual(['audio invalid: missing file "missing.m4a"']);
    expect((await readArtifact(dir)).audio).toBe("missing.m4a");
  });

  test("keeps a podcast with valid m4a audio", async () => {
    const artifact = { type: "podcast", slug: "real-podcast", audio: "episode.m4a" };
    const dir = await tempArtifactDir(artifact);
    await writeFile(
      join(dir, "episode.m4a"),
      new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
        0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00,
      ]),
    );

    const result = await preflightArtifactMediaForPublish(dir, artifact);

    expect(result.blockReason).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect((await readArtifact(dir)).audio).toBe("episode.m4a");
  });

  test("blocks a clip without valid video before tc-publish", async () => {
    const artifact = { type: "clip", slug: "fake-clip", video: "missing.mp4" };
    const dir = await tempArtifactDir(artifact);

    const result = await preflightArtifactMediaForPublish(dir, artifact);

    expect(result.blockReason).toBe('video required for clip but missing file "missing.mp4"');
    expect(result.warnings).toEqual(['video invalid: missing file "missing.mp4"']);
    expect((await readArtifact(dir)).video).toBe("missing.mp4");
  });

  test("publish stage records held rich-media artifacts structurally", async () => {
    const root = await mkdtemp(join(tmpdir(), "distillery-agent-held-"));
    dirs.push(root);
    const artifactDir = join(root, "podcast", "fake-podcast");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      join(artifactDir, "artifact.json"),
      `${JSON.stringify({
        type: "podcast",
        slug: "fake-podcast",
        headline: "Fake Podcast",
        audio: "missing.m4a",
      })}\n`,
    );
    const state: RunState = {
      run_id: "run-1781811131857-held01",
      status: "running",
      published: [],
      startedAt: Date.now(),
      log: [],
    };
    const ctx: PipelineContext = {
      active: { spaceId: "applications" } as unknown as ActiveDelegation,
      state,
      onProgress: () => {},
      space: "applications",
      corpusDir: join(root, "corpus"),
      artifactsDir: root,
      targetArtifactType: "podcast",
      step: (msg) => {
        state.log.push(`2026-06-18T19:39:56.704Z ${msg}`);
      },
    };

    await runPublishStage(ctx);

    expect(state.published).toEqual([]);
    expect(state.held).toEqual([
      {
        type: "podcast",
        slug: "fake-podcast",
        reason: 'audio required for podcast but missing file "missing.m4a"',
      },
    ]);
    expect(state.media).toEqual({ heroImages: 0, audio: 0, video: 0 });
    expect(state.proof).toMatchObject({
      ok: false,
      targetArtifactType: "podcast",
    });
    expect(state.proof?.checks.find((check) => check.name === "target: published podcast")).toMatchObject({
      ok: false,
    });
    expect(state.log.join("\n")).toContain("1 draft(s) held");
    expect(state.log.join("\n")).toContain("target proof failed for podcast");
  });
});
