import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugify, type Artifact } from "../skills/_shared/lib/artifact.ts";
import {
  quoteCard,
  parseArgs,
  resolveLine,
  UsageError,
  TEXT_MODES,
  type ImageProvider,
} from "../skills/quote-card/scripts/quote-card.ts";

const SCRIPT = join(
  import.meta.dir,
  "..",
  "skills",
  "quote-card",
  "scripts",
  "quote-card.ts",
);

const PNG_BYTES = new TextEncoder().encode("fake-png-bytes");

/** An approved outward source artifact with a quotable line. */
function approvedSource(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "src-1",
    type: "social-post",
    headline: "Ship the demo before the deck",
    body: "We learned to ship the demo before the deck.",
    quote: "Ship the demo before the deck.",
    attribution: "the team",
    tags: ["shipping", "demos"],
    source_transcripts: ["/tmp/standup.md"],
    source_quotes: [
      { quote: "ship the demo before the deck", transcript: "/tmp/standup.md" },
    ],
    generated_at: "2026-06-10T12:00:00.000Z",
    quality: { critic_pass: true, quotes_verified: true },
    approval_status: "approved",
    audience: "public",
    platform: "x",
    ...overrides,
  };
}

function fakeProvider(
  mimeType = "image/png",
  bytes: Uint8Array = PNG_BYTES,
): ImageProvider & { calls: { prompt: string; aspectRatio?: string }[] } {
  const calls: { prompt: string; aspectRatio?: string }[] = [];
  const provider = (async (opts) => {
    calls.push({ prompt: opts.prompt, aspectRatio: opts.aspectRatio });
    return { bytes, mimeType };
  }) as ImageProvider & { calls: typeof calls };
  provider.calls = calls;
  return provider;
}

describe("parseArgs", () => {
  test("parses a full generation invocation", () => {
    const args = parseArgs([
      "--source-dir", "artifacts/social-post/foo",
      "--prompt", "a navy field",
      "--line", "Ship the demo.",
      "--aspect", "9:16",
      "--text-mode", "model-baked",
      "--out-dir", "out",
      "--note", "retry: garbled text",
      "--skip-existing",
    ]);
    expect(args).toEqual({
      sourceDir: "artifacts/social-post/foo",
      prompt: "a navy field",
      promptFile: undefined,
      line: "Ship the demo.",
      aspectRatio: "9:16",
      textMode: "model-baked",
      outDir: "out",
      note: "retry: garbled text",
      skipExisting: true,
    });
  });

  test("defaults aspect to 1:1 and text-mode to composited", () => {
    const args = parseArgs(["--source-dir", "d", "--prompt", "p"]);
    expect(args.aspectRatio).toBe("1:1");
    expect(args.textMode).toBe("composited");
    expect(args.skipExisting).toBe(false);
  });

  test("accepts --prompt-file", () => {
    expect(
      parseArgs(["--source-dir", "d", "--prompt-file", "p.txt"]).promptFile,
    ).toBe("p.txt");
  });

  test("requires --source-dir when generating", () => {
    expect(() => parseArgs(["--prompt", "p"])).toThrow(UsageError);
  });

  test("requires exactly one of --prompt / --prompt-file", () => {
    expect(() => parseArgs(["--source-dir", "d"])).toThrow(UsageError);
    expect(() =>
      parseArgs(["--source-dir", "d", "--prompt", "p", "--prompt-file", "f"]),
    ).toThrow(UsageError);
  });

  test("rejects an unknown --text-mode", () => {
    expect(() =>
      parseArgs(["--source-dir", "d", "--prompt", "p", "--text-mode", "wat"]),
    ).toThrow(UsageError);
  });

  test("annotate mode requires --quote-dir and forbids generation flags", () => {
    const args = parseArgs(["--quote-dir", "q", "--annotate", "looks good"]);
    expect(args.annotate).toBe("looks good");
    expect(args.quoteDir).toBe("q");

    expect(() => parseArgs(["--annotate", "x"])).toThrow(UsageError);
    expect(() =>
      parseArgs(["--quote-dir", "q", "--annotate", "x", "--prompt", "p"]),
    ).toThrow(UsageError);
    expect(() =>
      parseArgs(["--quote-dir", "q", "--annotate", "x", "--skip-existing"]),
    ).toThrow(UsageError);
  });

  test("rejects --quote-dir in generate mode", () => {
    expect(() =>
      parseArgs(["--source-dir", "d", "--prompt", "p", "--quote-dir", "q"]),
    ).toThrow(UsageError);
  });

  test("rejects flags missing their value and unknown flags", () => {
    expect(() => parseArgs(["--source-dir"])).toThrow(UsageError);
    expect(() =>
      parseArgs(["--source-dir", "d", "--prompt", "--skip-existing"]),
    ).toThrow(UsageError);
    expect(() =>
      parseArgs(["--source-dir", "d", "--prompt", "p", "--wat"]),
    ).toThrow(UsageError);
  });

  test("TEXT_MODES exposes the two supported modes", () => {
    expect([...TEXT_MODES]).toEqual(["model-baked", "composited"]);
  });
});

describe("resolveLine", () => {
  test("explicit --line wins", () => {
    expect(resolveLine(approvedSource(), "Custom line")).toBe("Custom line");
  });
  test("falls back to quote, then headline", () => {
    expect(resolveLine(approvedSource())).toBe("Ship the demo before the deck.");
    expect(resolveLine(approvedSource({ quote: undefined }))).toBe(
      "Ship the demo before the deck",
    );
  });
  test("throws when there is no line", () => {
    expect(() =>
      resolveLine(approvedSource({ quote: undefined, headline: "  " } as Partial<Artifact>)),
    ).toThrow("no line to render");
  });
});

describe("quoteCard — generate", () => {
  let root: string;
  let sourceDir: string;
  let sourceJson: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "distillery-quotecard-"));
    sourceDir = join(root, "src");
    await mkdir(sourceDir, { recursive: true });
    sourceJson = join(sourceDir, "artifact.json");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(artifact: Artifact = approvedSource()) {
    await writeFile(sourceJson, JSON.stringify(artifact, null, 2) + "\n");
  }

  function args(overrides: Record<string, unknown> = {}) {
    return {
      sourceDir,
      prompt: "a deep navy field with a coral diagonal, clean center",
      aspectRatio: "1:1",
      textMode: "composited" as const,
      outDir: join(root, "artifacts"),
      skipExisting: false,
      ...overrides,
    };
  }

  test("gate: refuses a non-approved source", async () => {
    await seed(approvedSource({ approval_status: "pending" }));
    expect(quoteCard(args(), fakeProvider())).rejects.toThrow(
      "operates on APPROVED content only",
    );
  });

  test("gate: refuses a source with approval unset (inward type)", async () => {
    await seed(approvedSource({ type: "insight-card", approval_status: undefined }));
    expect(quoteCard(args(), fakeProvider())).rejects.toThrow(
      "not approved",
    );
  });

  test("writes quote.png + a pending quote-card artifact carrying provenance", async () => {
    await seed();
    const provider = fakeProvider();
    const result = await quoteCard(args(), provider);

    expect(result.status).toBe("generated");
    expect(result.line).toBe("Ship the demo before the deck.");

    const slug = slugify("Ship the demo before the deck.");
    const quoteDir = join(root, "artifacts", "quote-card", slug);
    expect(result.quoteDir).toBe(quoteDir);
    expect(result.cardPath).toBe(join(quoteDir, "quote.png"));

    expect(provider.calls).toEqual([
      {
        prompt: "a deep navy field with a coral diagonal, clean center",
        aspectRatio: "1:1",
      },
    ]);

    const card = await readFile(join(quoteDir, "quote.png"));
    expect(new Uint8Array(card)).toEqual(PNG_BYTES);

    const out = JSON.parse(await readFile(result.jsonPath, "utf8")) as Artifact;
    expect(out.type).toBe("quote-card");
    expect(out.quote).toBe("Ship the demo before the deck.");
    expect(out.headline).toBe("Ship the demo before the deck");
    expect(out.hero_image).toBe("quote.png");
    // Provenance carried from the source.
    expect(out.source_transcripts).toEqual(["/tmp/standup.md"]);
    expect(out.source_quotes).toEqual(approvedSource().source_quotes);
    expect(out.attribution).toBe("the team");
    expect(out.tags).toEqual(["shipping", "demos"]);
    expect(out.audience).toBe("public");
    expect(out.platform).toBe("x");
    // The new card is its own thing to approve — pending by default.
    expect(out.approval_status).toBe("pending");
    expect(out.quality.critic_pass).toBe(false);
    expect(out.quality.quotes_verified).toBe(true);
    expect(out.quality.notes).toContain("derived from approved social-post");
    expect(out.quality.notes).toContain("text-mode=composited");
    expect(out.quality.notes).toContain("composited separately");
  });

  test("model-baked text mode is recorded with a zoom-inspect warning", async () => {
    await seed();
    const result = await quoteCard(
      args({ textMode: "model-baked" }),
      fakeProvider(),
    );
    const out = JSON.parse(await readFile(result.jsonPath, "utf8")) as Artifact;
    expect(out.quality.notes).toContain("text-mode=model-baked");
    expect(out.quality.notes).toContain("ZOOM-INSPECT");
  });

  test("--line overrides the source quote and drives the slug", async () => {
    await seed();
    const result = await quoteCard(
      args({ line: "Earned secrets compound." }),
      fakeProvider(),
    );
    expect(result.line).toBe("Earned secrets compound.");
    expect(result.quoteDir).toBe(
      join(root, "artifacts", "quote-card", slugify("Earned secrets compound.")),
    );
    const out = JSON.parse(await readFile(result.jsonPath, "utf8")) as Artifact;
    expect(out.quote).toBe("Earned secrets compound.");
  });

  test("uses the extension from the mimeType and removes a stale card", async () => {
    await seed();
    // First render → png.
    await quoteCard(args(), fakeProvider());
    const slug = slugify("Ship the demo before the deck.");
    const quoteDir = join(root, "artifacts", "quote-card", slug);
    expect(existsSync(join(quoteDir, "quote.png"))).toBe(true);

    // Regenerate → jpg; stale png is dropped.
    const result = await quoteCard(args(), fakeProvider("image/jpeg"));
    expect(result.cardPath).toBe(join(quoteDir, "quote.jpg"));
    expect(existsSync(join(quoteDir, "quote.jpg"))).toBe(true);
    expect(existsSync(join(quoteDir, "quote.png"))).toBe(false);
    const out = JSON.parse(await readFile(result.jsonPath, "utf8")) as Artifact;
    expect(out.hero_image).toBe("quote.jpg");
  });

  test("falls back to .png for unknown mime types", async () => {
    await seed();
    const result = await quoteCard(args(), fakeProvider("image/whatever"));
    expect(result.cardPath?.endsWith("quote.png")).toBe(true);
  });

  test("appends custom --note", async () => {
    await seed();
    const result = await quoteCard(
      args({ note: "retry: stray letters in attempt 1" }),
      fakeProvider(),
    );
    const out = JSON.parse(await readFile(result.jsonPath, "utf8")) as Artifact;
    expect(out.quality.notes).toContain("retry: stray letters in attempt 1");
  });

  test("reads the prompt from --prompt-file", async () => {
    await seed();
    const promptFile = join(root, "prompt.txt");
    await writeFile(promptFile, "  a clean off-white field \n");
    const provider = fakeProvider();
    await quoteCard(args({ prompt: undefined, promptFile }), provider);
    expect(provider.calls[0]?.prompt).toBe("a clean off-white field");
  });

  test("fails on a missing or empty prompt file", async () => {
    await seed();
    expect(
      quoteCard(
        args({ prompt: undefined, promptFile: join(root, "nope.txt") }),
        fakeProvider(),
      ),
    ).rejects.toThrow("could not read prompt file");

    const empty = join(root, "empty.txt");
    await writeFile(empty, "   \n");
    expect(
      quoteCard(args({ prompt: undefined, promptFile: empty }), fakeProvider()),
    ).rejects.toThrow("prompt is empty");
  });

  test("--skip-existing skips when the card exists", async () => {
    await seed();
    await quoteCard(args(), fakeProvider());
    const provider = fakeProvider();
    const result = await quoteCard(args({ skipExisting: true }), provider);
    expect(result.status).toBe("skipped");
    expect(provider.calls).toHaveLength(0);
  });

  test("--skip-existing regenerates when the card image is missing", async () => {
    await seed();
    const first = await quoteCard(args(), fakeProvider());
    // Remove the image but keep the json.
    await rm(first.cardPath!);
    const provider = fakeProvider();
    const result = await quoteCard(args({ skipExisting: true }), provider);
    expect(result.status).toBe("generated");
    expect(provider.calls).toHaveLength(1);
  });

  test("fails when the source artifact.json is missing", async () => {
    expect(quoteCard(args(), fakeProvider())).rejects.toThrow(
      "no artifact.json found",
    );
  });

  test("fails on a contract-invalid source", async () => {
    await writeFile(
      sourceJson,
      JSON.stringify({ ...approvedSource(), headline: "", quality: undefined }),
    );
    expect(quoteCard(args(), fakeProvider())).rejects.toThrow("fails the contract");
  });

  test("propagates provider failure (json/image written only on success)", async () => {
    await seed();
    const provider: ImageProvider = async () => {
      throw new Error("gemini image 429: quota");
    };
    expect(quoteCard(args(), provider)).rejects.toThrow("gemini image 429");
    const slug = slugify("Ship the demo before the deck.");
    expect(
      existsSync(join(root, "artifacts", "quote-card", slug, "artifact.json")),
    ).toBe(false);
  });
});

describe("quoteCard — annotate", () => {
  let root: string;
  let quoteDir: string;
  let jsonPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "distillery-quotecard-an-"));
    quoteDir = join(root, "qc");
    await mkdir(quoteDir, { recursive: true });
    jsonPath = join(quoteDir, "artifact.json");
    const card: Artifact = {
      id: "qc-1",
      type: "quote-card",
      headline: "Ship the demo before the deck",
      quote: "Ship the demo before the deck.",
      tags: ["shipping"],
      source_transcripts: ["/tmp/standup.md"],
      hero_image: "quote.png",
      generated_at: "2026-06-10T12:00:00.000Z",
      quality: { critic_pass: false, quotes_verified: true, notes: "rendered" },
      approval_status: "pending",
    };
    await writeFile(jsonPath, JSON.stringify(card, null, 2) + "\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("appends a note without calling the provider", async () => {
    const provider = fakeProvider();
    const result = await quoteCard(
      {
        quoteDir,
        annotate: "card reviewed: minimal, no stray text",
        aspectRatio: "1:1",
        textMode: "composited",
        skipExisting: false,
      },
      provider,
    );
    expect(result.status).toBe("annotated");
    expect(provider.calls).toHaveLength(0);
    const out = JSON.parse(await readFile(jsonPath, "utf8")) as Artifact;
    expect(out.quality.notes).toBe(
      "rendered | [quote-card] card reviewed: minimal, no stray text",
    );
    // Does not flip approval.
    expect(out.approval_status).toBe("pending");
  });
});

describe("CLI wiring", () => {
  test("exits 2 with usage on bad arguments, without touching the network", () => {
    const proc = Bun.spawnSync({ cmd: ["bun", SCRIPT], stderr: "pipe", stdout: "pipe" });
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("usage:");
    expect(stderr).toContain("--source-dir is required");
  });

  test("exits 1 when the source dir has no artifact.json", () => {
    const proc = Bun.spawnSync({
      cmd: [
        "bun", SCRIPT,
        "--source-dir", join(tmpdir(), "distillery-definitely-missing-src"),
        "--prompt", "p",
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(proc.exitCode).toBe(1);
    expect(new TextDecoder().decode(proc.stderr)).toContain("no artifact.json found");
  });
});
