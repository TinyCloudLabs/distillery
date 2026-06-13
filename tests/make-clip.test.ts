import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateImage,
  generateVideo,
  QUEUE_BASE,
  GPT_IMAGE_2,
  SEEDANCE_2,
  STORAGE_BASE,
} from "../skills/_shared/lib/fal.ts";
import {
  buildCaptionArgs,
  buildDrawtextFilter,
  DEFAULT_FONT,
  isSafeFontColor,
  isSafeFontPath,
} from "../skills/make-clip/scripts/caption.ts";
import {
  buildAudioArgs,
  buildFrameArgs,
} from "../skills/make-clip/scripts/extract-frames.ts";
import {
  ARTIFACT_TYPES,
  FORMAT_REGISTRY,
  isOutwardType,
  validateArtifact,
  writeArtifact,
  type Artifact,
} from "../skills/_shared/lib/artifact.ts";

// ---------------------------------------------------------------------------
// The `clip` artifact type is registered as an internal, explorable format
// ---------------------------------------------------------------------------

describe("clip format registration", () => {
  test("clip is a known artifact type, internal + explorable, mined by make-clip", () => {
    expect(ARTIFACT_TYPES).toContain("clip");
    expect(isOutwardType("clip")).toBe(false);
    expect(FORMAT_REGISTRY.clip.miner).toBe("make-clip");
    expect(FORMAT_REGISTRY.clip.explorable).toBe(true);
    expect(FORMAT_REGISTRY.clip.label).toBe("Clip");
  });
});

// ---------------------------------------------------------------------------
// High-level stage callers — fetch mocked, no live API
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call { url: string; init: RequestInit }
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: Call[];
} {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { calls };
}
const noSleep = async () => {};

describe("generateImage (stage caller)", () => {
  test("submits the GPT Image 2 endpoint and downloads the first media url", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const seen = mockFetch((url) => {
      if (url === `${QUEUE_BASE}/${GPT_IMAGE_2}`)
        return Response.json({ request_id: "img-1", status_url: "https://q/s", response_url: "https://q/r" });
      if (url.startsWith("https://q/s")) return Response.json({ status: "COMPLETED" });
      if (url === "https://q/r")
        return Response.json({ images: [{ url: "https://cdn/identity.png", content_type: "image/png" }] });
      if (url === "https://cdn/identity.png")
        return new Response(pngBytes, { headers: { "content-type": "image/png" } });
      return new Response("x", { status: 500 });
    });

    const res = await generateImage(
      { prompt: "identity prompt", imageSize: { width: 1600, height: 2000 } },
      { apiKey: "k", sleep: noSleep },
    );
    expect(res.bytes).toEqual(pngBytes);
    expect(res.url).toBe("https://cdn/identity.png");
    expect(res.request_id).toBe("img-1");

    const submitBody = JSON.parse(seen.calls[0]!.init.body as string);
    expect(submitBody.image_size).toEqual({ width: 1600, height: 2000 });
    expect(submitBody.quality).toBe("high");
  });
});

describe("generateVideo (stage caller)", () => {
  test("submits Seedance and prefers the mp4 media ref", async () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x18]);
    mockFetch((url) => {
      if (url === `${QUEUE_BASE}/${SEEDANCE_2}`)
        return Response.json({ request_id: "vid-1", status_url: "https://q/s", response_url: "https://q/r" });
      if (url.startsWith("https://q/s")) return Response.json({ status: "COMPLETED" });
      if (url === "https://q/r")
        return Response.json({
          // a poster image precedes the video to prove mp4-preference
          poster: { url: "https://cdn/poster.png", content_type: "image/png" },
          video: { url: "https://cdn/clip.mp4", content_type: "video/mp4" },
          seed: 4242,
        });
      if (url === "https://cdn/clip.mp4") return new Response(mp4, { headers: { "content-type": "video/mp4" } });
      if (url === "https://cdn/poster.png") return new Response(new Uint8Array([1]));
      return new Response("x", { status: 500 });
    });

    const res = await generateVideo(
      { prompt: "video prompt @Image1 @Image2", imageUrls: ["https://a/i.png", "https://a/s.png"] },
      { apiKey: "k", sleep: noSleep },
    );
    expect(res.bytes).toEqual(mp4);
    expect(res.url).toBe("https://cdn/clip.mp4");
    expect(res.raw.seed).toBe(4242);
  });
});

// ---------------------------------------------------------------------------
// caption.ts — pure drawtext + ffmpeg argv construction
// ---------------------------------------------------------------------------

describe("buildDrawtextFilter", () => {
  test("places the fade window at the end and uses the textfile (no inline escaping)", () => {
    const f = buildDrawtextFilter(
      { text: "your data, where they can't blink it away.", durationSeconds: 15 },
      "/tmp/cap.txt",
    );
    // default hold 2.5, fade 1.0 → start at 12.5, matching the prototype.
    expect(f).toContain("textfile=/tmp/cap.txt");
    expect(f).toContain("fontfile=" + DEFAULT_FONT);
    expect(f).toContain("0.9*clip((t-12.500)/1.000");
    expect(f).toContain("y=0.82*h");
    expect(f).toContain("x=(w-text_w)/2");
    expect(f).toContain("fontsize=30");
  });

  test("honors custom hold/fade/size/color/font", () => {
    const f = buildDrawtextFilter(
      {
        text: "hi",
        durationSeconds: 10,
        hold: 3,
        fade: 0.5,
        fontSize: 48,
        fontColor: "yellow",
        fontFile: "/F.ttf",
      },
      "/t.txt",
    );
    expect(f).toContain("0.9*clip((t-7.000)/0.500"); // 10 - 3 = 7
    expect(f).toContain("fontsize=48");
    expect(f).toContain("fontcolor=yellow");
    expect(f).toContain("fontfile=/F.ttf");
  });

  test("rejects non-positive duration/fade", () => {
    expect(() => buildDrawtextFilter({ text: "x", durationSeconds: 0 }, "/t")).toThrow("duration");
    expect(() => buildDrawtextFilter({ text: "x", durationSeconds: 5, fade: 0 }, "/t")).toThrow("fade");
  });
});

describe("font/color charset guards (filtergraph metacharacter defense)", () => {
  test("isSafeFontPath accepts normal font paths, rejects graph metacharacters", () => {
    expect(isSafeFontPath(DEFAULT_FONT)).toBe(true);
    expect(isSafeFontPath("/path/to/My Font-Bold.ttf")).toBe(true);
    // ffmpeg filtergraph specials must all be rejected: : \ ' [ ] ,
    expect(isSafeFontPath("/f.ttf:fontcolor=red")).toBe(false); // option-injection
    expect(isSafeFontPath("/f.ttf,drawbox=...")).toBe(false); // filter-chain injection
    expect(isSafeFontPath("/f.ttf'")).toBe(false);
    expect(isSafeFontPath("/f[0].ttf")).toBe(false);
    expect(isSafeFontPath("/f\\.ttf")).toBe(false);
  });

  test("isSafeFontColor accepts names and hex (with @alpha), rejects metacharacters", () => {
    expect(isSafeFontColor("white")).toBe(true);
    expect(isSafeFontColor("yellow")).toBe(true);
    expect(isSafeFontColor("#FF0000")).toBe(true);
    expect(isSafeFontColor("white@0.8")).toBe(true);
    expect(isSafeFontColor("red:x=0")).toBe(false); // colon -> option injection
    expect(isSafeFontColor("red,crop=1")).toBe(false); // comma -> filter injection
    expect(isSafeFontColor("red'")).toBe(false);
    expect(isSafeFontColor("")).toBe(false);
  });
});

describe("buildCaptionArgs", () => {
  test("re-encodes video (libx264 crf18), copies audio untouched, faststart", () => {
    const args = buildCaptionArgs("in.mp4", "out.mp4", "drawtext=...");
    expect(args).toEqual([
      "-y", "-i", "in.mp4",
      "-vf", "drawtext=...",
      "-c:v", "libx264", "-crf", "18",
      "-c:a", "copy",
      "-movflags", "+faststart",
      "out.mp4",
    ]);
  });
});

// ---------------------------------------------------------------------------
// extract-frames.ts — pure ffmpeg argv for the blind-test gate
// ---------------------------------------------------------------------------

describe("buildFrameArgs", () => {
  test("count mode derives an even fps from the duration", () => {
    const args = buildFrameArgs({ input: "clip.mp4", outDir: "frames", count: 8, durationSeconds: 16 });
    // 8 frames / 16s = 0.5 fps
    expect(args).toContain("fps=0.500000");
    expect(args[args.length - 1]).toBe(join("frames", "f%03d.png"));
  });

  test("fps mode samples at the fixed rate", () => {
    const args = buildFrameArgs({ input: "clip.mp4", outDir: "frames", fps: 4 });
    expect(args).toContain("fps=4");
  });

  test("count mode requires a positive duration", () => {
    expect(() => buildFrameArgs({ input: "c.mp4", outDir: "f", count: 8 })).toThrow("durationSeconds");
  });

  test("rejects non-positive count/fps", () => {
    expect(() => buildFrameArgs({ input: "c.mp4", outDir: "f", fps: 0 })).toThrow("fps");
    expect(() => buildFrameArgs({ input: "c.mp4", outDir: "f", count: 0, durationSeconds: 5 })).toThrow("count");
  });

  test("buildAudioArgs copies the audio stream", () => {
    expect(buildAudioArgs("clip.mp4", "audio.aac")).toEqual([
      "-y", "-i", "clip.mp4", "-vn", "-acodec", "copy", "audio.aac",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Artifact shape — a clip artifact validates and persists feed-ready
// ---------------------------------------------------------------------------

function clipArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "clip-1",
    type: "clip",
    headline: "Wasn't Tripping",
    body: "A keeper guards three glowing data-orbs; an indifferent machine-moon tries to take them; ownership wins.",
    tags: ["data-sovereignty", "video:clip-captioned.mp4"],
    source_transcripts: ["/transcripts/2026-05-15-team.md"],
    source_quotes: [
      { quote: "I wasn't tripping.", speaker: "Hunter", transcript: "/transcripts/2026-05-15-team.md" },
    ],
    hero_image: "poster.png",
    generated_at: new Date().toISOString(),
    generation_model: "seedance-2.0",
    quality: {
      critic_pass: true,
      quotes_verified: true,
      notes: "[novelty] lead=cross-meeting-topic: in-memory wipe -> sovereignty. metaphor-distance=grounded-allegory; blind-test PASS (stranger reconstructed the theft + felt the defiance).",
    },
    ...overrides,
  };
}

describe("clip artifact contract", () => {
  test("a well-formed clip artifact validates", () => {
    const res = validateArtifact(clipArtifact());
    expect(res.ok).toBe(true);
  });

  test("clip is internal: validateArtifact does NOT force approval_status pending", () => {
    const res = validateArtifact(clipArtifact());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.artifact.approval_status).toBeUndefined();
  });

  test("requires the quality block (blind-test gate state must be inspectable)", () => {
    const bad = clipArtifact();
    delete (bad as Partial<Artifact>).quality;
    const res = validateArtifact(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("quality");
  });

  test("writeArtifact persists json + media into artifacts/clip/<slug>/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "make-clip-test-"));
    try {
      const written = await writeArtifact(clipArtifact(), {
        outDir: dir,
        media: {
          "clip-captioned.mp4": new Uint8Array([0, 0, 0, 1]),
          "poster.png": new Uint8Array([0x89, 0x50]),
          "narrative.md": new Uint8Array(Buffer.from("# narrative")),
        },
      });
      expect(written.jsonPath).toContain(join("clip", "wasn-t-tripping", "artifact.json"));
      const files = await readdir(written.dir);
      expect(files.sort()).toEqual(
        ["artifact.json", "clip-captioned.mp4", "narrative.md", "poster.png"].sort(),
      );
      const saved = JSON.parse(await readFile(written.jsonPath, "utf8")) as Artifact;
      expect(saved.type).toBe("clip");
      expect(saved.hero_image).toBe("poster.png");
      expect(saved.tags).toContain("video:clip-captioned.mp4");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Doctrine encoded in SKILL.md + templates (prompt-assembly / locks coverage)
// ---------------------------------------------------------------------------

describe("SKILL.md encodes the doctrine", () => {
  let skill = "";
  test("loads", async () => {
    skill = await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    expect(skill.length).toBeGreaterThan(2000);
  });

  test("frames the three-stage compiler + IR over-constraint", async () => {
    skill ||= await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    expect(skill).toContain("narrative -> storyboard SHEET -> video");
    expect(skill).toMatch(/INTERMEDIATE REPRESENTATION/);
    expect(skill).toMatch(/OVER-CONSTRAINS/);
  });

  test("two-reference technique: @Image1 identity / @Image2 storyboard", async () => {
    skill ||= await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    expect(skill).toContain("@Image1");
    expect(skill).toContain("@Image2");
    expect(skill).toMatch(/identity image = WHO/);
    expect(skill).toMatch(/storyboard sheet = WHAT/);
  });

  test("names every lock in the LOCKS LIBRARY", async () => {
    skill ||= await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    for (const lock of [
      "Spatial-continuity lock",
      "Signature-effect lock",
      "Exact-count",
      "Scale anchor",
      "Dim lock",
      "Body-language disambiguation lock",
      "Pre-stage every finale prop",
      "Sample the final panel",
    ]) {
      expect(skill).toContain(lock);
    }
  });

  test("metaphor-distance dial with the three settings + iconography", async () => {
    skill ||= await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    expect(skill).toMatch(/metaphor-distance/i);
    expect(skill).toContain("literal");
    expect(skill).toContain("grounded-allegory");
    expect(skill).toContain("pure-allegory");
    expect(skill).toMatch(/ICONOGRAPHY/);
  });

  test("gesture/4-beat + held button", async () => {
    skill ||= await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    expect(skill).toMatch(/15 seconds is a gesture/i);
    expect(skill).toMatch(/setup -> turn -> button/);
    expect(skill).toMatch(/BUTTON/);
  });

  test("blind-reconstruction gate + fix routing by failure type", async () => {
    skill ||= await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    expect(skill).toMatch(/blind-reconstruction/i);
    expect(skill).toMatch(/CONTEXT-FREE/);
    expect(skill).toMatch(/identity drift.*stage 1/i);
    expect(skill).toMatch(/storyboard/);
  });

  test("retry modes strict vs speculative + economics", async () => {
    skill ||= await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    expect(skill).toContain("`strict`");
    expect(skill).toContain("`speculative`");
    expect(skill).toMatch(/CHEAP stages/);
  });

  test("square default + feed follow-up flag", async () => {
    skill ||= await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    expect(skill).toMatch(/SQUARE \(1:1\) is the default/);
    expect(skill).toContain("styles.css:529");
    expect(skill).toMatch(/Feed follow-up/);
  });

  test("caption is post-process only, both outputs", async () => {
    skill ||= await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    expect(skill).toMatch(/post-process only/i);
    expect(skill).toMatch(/BOTH captioned \+ clean/);
  });

  test("fal facts present (models, string duration, storage host, key)", async () => {
    skill ||= await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    expect(skill).toContain("openai/gpt-image-2");
    expect(skill).toContain("bytedance/seedance-2.0/reference-to-video");
    expect(skill).toContain("rest.alpha.fal.ai");
    expect(skill).toContain("FAL_KEY");
    expect(skill).toMatch(/STRING enum/);
  });

  test("transcript-derived narrative + artifact contract + zero-clips-valid", async () => {
    skill ||= await readFile(join(import.meta.dir, "..", "skills", "make-clip", "SKILL.md"), "utf8");
    expect(skill).toMatch(/EMOTIONAL TRUTH/);
    expect(skill).toMatch(/source_quotes/);
    expect(skill).toMatch(/Zero clips is a valid result/i);
  });
});

describe("templates exist and parameterize the locks (not hardcoded story)", () => {
  async function tpl(name: string): Promise<string> {
    return readFile(join(import.meta.dir, "..", "skills", "make-clip", "templates", name), "utf8");
  }

  test("identity template: pre-stage props + exact counts + iconography, ALL-CAPS slots", async () => {
    const t = await tpl("01-identity.md");
    expect(t).toMatch(/PRE-STAGE EVERY PROP/);
    expect(t).toMatch(/EXACT COUNTS/);
    expect(t).toMatch(/ICONOGRAPHY LOCK/);
    expect(t).toContain("CHARACTER =");
    // not hardcoded to the prototype's cloud-spirit story
    expect(t).not.toContain("cloud-spirit keeper with a stitched belly pouch tending");
  });

  test("storyboard template: full locks library + state machine + grayscale", async () => {
    const t = await tpl("02-storyboard-sheet.md");
    expect(t).toMatch(/SPATIAL-CONTINUITY LOCK/);
    expect(t).toMatch(/STATE MACHINE/);
    expect(t).toMatch(/DIM LOCK/);
    expect(t).toMatch(/DISAMBIGUATION LOCK/);
    expect(t).toMatch(/grayscale/i);
    expect(t).toContain("[SPATIAL CONTINUITY LOCK]");
    expect(t).toContain("[DIRECTOR STRIP]");
  });

  test("video template: @Image1/@Image2 binding + diegetic audio + button + fix-routing", async () => {
    const t = await tpl("03-video.md");
    expect(t).toContain("@Image1");
    expect(t).toContain("@Image2");
    expect(t).toMatch(/do not render the storyboard sheet itself/i);
    expect(t).toMatch(/diegetic/i);
    expect(t).toMatch(/THE BUTTON/);
    expect(t).toMatch(/identity drift.*stage 1/i);
  });
});
