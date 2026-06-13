import { afterEach, describe, expect, test } from "bun:test";
import {
  buildImageRequestBody,
  buildVideoRequestBody,
  collectMediaUrls,
  contentTypeFor,
  FalError,
  GPT_IMAGE_2,
  QUEUE_BASE,
  isValidDuration,
  runQueueJob,
  SEEDANCE_2,
  STORAGE_BASE,
  uploadToFalStorage,
  VALID_DURATIONS,
  validateImageSize,
  type VideoDuration,
} from "../skills/_shared/lib/fal.ts";

// ---------------------------------------------------------------------------
// Request-body builders (pure — no network)
// ---------------------------------------------------------------------------

describe("buildImageRequestBody", () => {
  test("defaults to 1024x1024 high quality", () => {
    const body = buildImageRequestBody({ prompt: "a thing" });
    expect(body).toEqual({
      prompt: "a thing",
      image_size: { width: 1024, height: 1024 },
      quality: "high",
    });
  });

  test("passes an explicit pixel box and quality through", () => {
    const body = buildImageRequestBody({
      prompt: "x",
      imageSize: { width: 1920, height: 1088 },
      quality: "medium",
    });
    expect(body.image_size).toEqual({ width: 1920, height: 1088 });
    expect(body.quality).toBe("medium");
  });

  test("accepts a preset string for image_size", () => {
    const body = buildImageRequestBody({ prompt: "x", imageSize: "square_hd" });
    expect(body.image_size).toBe("square_hd");
  });

  test("rejects an empty prompt", () => {
    expect(() => buildImageRequestBody({ prompt: "  " })).toThrow("prompt");
  });
});

describe("validateImageSize", () => {
  test("accepts a valid box", () => {
    expect(() => validateImageSize({ width: 1600, height: 2000 })).not.toThrow();
  });
  test("rejects non-multiple-of-16", () => {
    expect(() => validateImageSize({ width: 1000, height: 1000 })).toThrow("multiple of 16");
  });
  test("rejects an edge over 3840", () => {
    expect(() => validateImageSize({ width: 3856, height: 16 })).toThrow("max edge");
  });
  test("rejects exceeding the pixel budget", () => {
    // 3840 x 3840 is multiple-of-16 and within edge, but over the pixel cap.
    expect(() => validateImageSize({ width: 3840, height: 3840 })).toThrow("exceeds max");
  });
  test("rejects a non-positive dimension", () => {
    expect(() => validateImageSize({ width: 0, height: 16 })).toThrow("positive integer");
  });
});

describe("buildVideoRequestBody", () => {
  test("defaults: duration 15, 720p, 1:1 square, audio on", () => {
    const body = buildVideoRequestBody({
      prompt: "go",
      imageUrls: ["https://a/identity.png", "https://a/storyboard.png"],
    });
    expect(body).toEqual({
      prompt: "go",
      image_urls: ["https://a/identity.png", "https://a/storyboard.png"],
      duration: "15",
      resolution: "720p",
      aspect_ratio: "1:1",
      generate_audio: true,
    });
  });

  test("square 1:1 is the feed-native default aspect ratio", () => {
    const body = buildVideoRequestBody({ prompt: "p", imageUrls: ["https://a/x.png"] });
    expect(body.aspect_ratio).toBe("1:1");
  });

  test("honors explicit aspect/duration/resolution/seed and includes seed only when given", () => {
    const body = buildVideoRequestBody({
      prompt: "p",
      imageUrls: ["https://a/x.png"],
      aspectRatio: "9:16",
      duration: "10",
      resolution: "1080p",
      generateAudio: false,
      seed: 12345,
    });
    expect(body.aspect_ratio).toBe("9:16");
    expect(body.duration).toBe("10");
    expect(body.resolution).toBe("1080p");
    expect(body.generate_audio).toBe(false);
    expect(body.seed).toBe(12345);

    const noSeed = buildVideoRequestBody({ prompt: "p", imageUrls: ["https://a/x.png"] });
    expect("seed" in noSeed).toBe(false);
  });

  test("duration is a STRING on the wire (Seedance enum), not a number", () => {
    const body = buildVideoRequestBody({ prompt: "p", imageUrls: ["https://a/x.png"] });
    expect(typeof body.duration).toBe("string");
  });

  test("rejects empty/oversized image_urls", () => {
    expect(() => buildVideoRequestBody({ prompt: "p", imageUrls: [] })).toThrow("at least one");
    const ten = Array.from({ length: 10 }, (_, i) => `https://a/${i}.png`);
    expect(() => buildVideoRequestBody({ prompt: "p", imageUrls: ten })).toThrow("at most 9");
    expect(() => buildVideoRequestBody({ prompt: "p", imageUrls: [""] })).toThrow("non-empty");
  });

  test("rejects an out-of-enum duration with a FalError (defensive library guard)", () => {
    const call = () =>
      buildVideoRequestBody({
        prompt: "p",
        imageUrls: ["https://a/x.png"],
        // Force a bad value past the type system the way a JS caller could.
        duration: "20" as unknown as VideoDuration,
      });
    expect(call).toThrow(FalError);
    expect(call).toThrow("duration must be one of");
  });

  test("accepts every documented duration value, plus 'auto'", () => {
    for (const d of VALID_DURATIONS) {
      const body = buildVideoRequestBody({ prompt: "p", imageUrls: ["https://a/x.png"], duration: d });
      expect(body.duration).toBe(d);
    }
  });
});

describe("isValidDuration / VALID_DURATIONS (shared source of truth)", () => {
  test("VALID_DURATIONS is '4'..'15' plus 'auto'", () => {
    expect(VALID_DURATIONS).toEqual([
      "4", "5", "6", "7", "8", "9", "10",
      "11", "12", "13", "14", "15", "auto",
    ]);
  });
  test("accepts in-enum strings, rejects everything else", () => {
    expect(isValidDuration("4")).toBe(true);
    expect(isValidDuration("15")).toBe(true);
    expect(isValidDuration("auto")).toBe(true);
    expect(isValidDuration("3")).toBe(false);
    expect(isValidDuration("16")).toBe(false);
    expect(isValidDuration("")).toBe(false);
    expect(isValidDuration(undefined)).toBe(false);
    expect(isValidDuration(15)).toBe(false); // number, not the string enum
  });
});

describe("collectMediaUrls", () => {
  test("walks nested objects/arrays and collects http(s) url refs", () => {
    const resp = {
      images: [{ url: "https://a/1.png", content_type: "image/png" }],
      video: { url: "https://a/clip.mp4", content_type: "video/mp4" },
      nested: { deep: { url: "http://a/2.webp" } },
      ignore: { url: "data:image/png;base64,AAAA" },
      seed: 7,
    };
    const media = collectMediaUrls(resp);
    expect(media.map((m) => m.url)).toEqual([
      "https://a/1.png",
      "https://a/clip.mp4",
      "http://a/2.webp",
    ]);
    expect(media[0]?.content_type).toBe("image/png");
  });
});

describe("contentTypeFor", () => {
  test("maps extensions", () => {
    expect(contentTypeFor("identity.png")).toBe("image/png");
    expect(contentTypeFor("x.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("x.webp")).toBe("image/webp");
    expect(contentTypeFor("clip.mp4")).toBe("video/mp4");
    expect(contentTypeFor("x.bin")).toBe("application/octet-stream");
  });
});

// ---------------------------------------------------------------------------
// Queue plumbing + storage upload — fetch mocked; no live API
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call { url: string; init: RequestInit }

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: Call[] } {
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

describe("runQueueJob", () => {
  test("submits with Key auth, polls status to COMPLETED, fetches the response", async () => {
    let polls = 0;
    const seen = mockFetch((url) => {
      if (url === `${QUEUE_BASE}/${GPT_IMAGE_2}`) {
        return Response.json({
          request_id: "req-1",
          status_url: "https://q/status",
          response_url: "https://q/response",
        });
      }
      if (url.startsWith("https://q/status")) {
        polls++;
        return Response.json({ status: polls >= 2 ? "COMPLETED" : "IN_PROGRESS" });
      }
      if (url === "https://q/response") {
        return Response.json({ images: [{ url: "https://cdn/out.png", content_type: "image/png" }], seed: 9 });
      }
      return new Response("unexpected", { status: 500 });
    });

    const statuses: string[] = [];
    const result = await runQueueJob(
      GPT_IMAGE_2,
      { prompt: "x" },
      { apiKey: "k", sleep: noSleep, onStatus: (s) => statuses.push(s) },
    );

    expect(result.request_id).toBe("req-1");
    expect(result.media).toEqual([{ url: "https://cdn/out.png", content_type: "image/png" }]);
    expect(result.raw.seed).toBe(9);
    expect(statuses).toEqual(["IN_PROGRESS", "COMPLETED"]);

    const submit = seen.calls[0]!;
    expect(submit.url).toBe(`${QUEUE_BASE}/${GPT_IMAGE_2}`);
    expect(submit.init.method).toBe("POST");
    expect((submit.init.headers as Record<string, string>).Authorization).toBe("Key k");
    // status poll carries logs=1
    expect(seen.calls[1]!.url).toBe("https://q/status?logs=1");
  });

  test("maps a 401 submit to an auth FalError (not retryable)", async () => {
    mockFetch(() => new Response("no key", { status: 401 }));
    try {
      await runQueueJob(SEEDANCE_2, { prompt: "x" }, { apiKey: "bad", sleep: noSleep });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FalError);
      const fe = e as FalError;
      expect(fe.status).toBe(401);
      expect(fe.isAuth).toBe(true);
      expect(fe.stage).toBe(SEEDANCE_2);
    }
  });

  test("throws on terminal FAILED status", async () => {
    mockFetch((url) => {
      if (url.includes("/status")) return Response.json({ status: "FAILED", error: "boom" });
      return Response.json({ request_id: "r", status_url: "https://q/status", response_url: "https://q/r" });
    });
    await expect(
      runQueueJob(GPT_IMAGE_2, { prompt: "x" }, { apiKey: "k", sleep: noSleep }),
    ).rejects.toThrow("FAILED");
  });

  test("times out if never COMPLETED", async () => {
    mockFetch((url) => {
      if (url.includes("/status")) return Response.json({ status: "IN_PROGRESS" });
      return Response.json({ request_id: "r", status_url: "https://q/status", response_url: "https://q/r" });
    });
    await expect(
      runQueueJob(GPT_IMAGE_2, { prompt: "x" }, { apiKey: "k", sleep: noSleep, timeoutMs: 0 }),
    ).rejects.toThrow("timeout");
  });

  test("a non-positive timeout bails immediately with NO status fetch (deadline checked before fetch/sleep)", async () => {
    const seen = mockFetch((url) => {
      if (url.includes("/status")) return Response.json({ status: "IN_PROGRESS" });
      return Response.json({ request_id: "r", status_url: "https://q/status", response_url: "https://q/r" });
    });
    await expect(
      runQueueJob(GPT_IMAGE_2, { prompt: "x" }, { apiKey: "k", sleep: noSleep, timeoutMs: -1 }),
    ).rejects.toThrow("timeout");
    // Only the submit POST happened — the deadline check at the top of the
    // loop short-circuits before any status_url poll.
    expect(seen.calls.length).toBe(1);
    expect(seen.calls[0]!.url).toBe(`${QUEUE_BASE}/${GPT_IMAGE_2}`);
    expect(seen.calls.some((c) => c.url.includes("/status"))).toBe(false);
  });

  test("an already-COMPLETED job is detected on the first poll with no upfront sleep", async () => {
    let slept = 0;
    const seen = mockFetch((url) => {
      if (url.includes("/status")) return Response.json({ status: "COMPLETED" });
      if (url === "https://q/r")
        return Response.json({ images: [{ url: "https://cdn/out.png", content_type: "image/png" }] });
      return Response.json({ request_id: "r", status_url: "https://q/status", response_url: "https://q/r" });
    });
    const result = await runQueueJob(
      GPT_IMAGE_2,
      { prompt: "x" },
      { apiKey: "k", sleep: async () => { slept++; } },
    );
    expect(result.media[0]?.url).toBe("https://cdn/out.png");
    // No sleep before the first (and only) status fetch.
    expect(slept).toBe(0);
    // submit -> one status poll -> response fetch.
    expect(seen.calls.map((c) => c.url)).toEqual([
      `${QUEUE_BASE}/${GPT_IMAGE_2}`,
      "https://q/status?logs=1",
      "https://q/r",
    ]);
  });
});

describe("uploadToFalStorage", () => {
  test("two-step: initiate on rest.alpha.fal.ai then PUT the bytes, returns file_url", async () => {
    const seen = mockFetch((url, init) => {
      if (url.startsWith(`${STORAGE_BASE}/storage/upload/initiate`)) {
        return Response.json({ upload_url: "https://put/here", file_url: "https://cdn/file.png" });
      }
      if (url === "https://put/here") {
        expect(init.method).toBe("PUT");
        return new Response("", { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });

    const fileUrl = await uploadToFalStorage(new Uint8Array([1, 2, 3]), "identity.png", { apiKey: "k" });
    expect(fileUrl).toBe("https://cdn/file.png");

    const init = seen.calls[0]!;
    expect(init.url).toBe(`${STORAGE_BASE}/storage/upload/initiate?storage_type=fal-cdn-v3`);
    expect((init.init.headers as Record<string, string>).Authorization).toBe("Key k");
    const body = JSON.parse(init.init.body as string);
    expect(body).toEqual({ content_type: "image/png", file_name: "identity.png" });
  });

  test("maps a failed initiate to a FalError with the storage-upload stage", async () => {
    mockFetch(() => new Response("denied", { status: 403 }));
    try {
      await uploadToFalStorage(new Uint8Array([1]), "x.png", { apiKey: "k" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FalError);
      expect((e as FalError).stage).toBe("storage-upload");
      expect((e as FalError).isAuth).toBe(true);
    }
  });
});
