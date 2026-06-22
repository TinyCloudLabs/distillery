import { afterEach, describe, expect, test } from "bun:test";
import {
  buildVeoPredictBody,
  generateVeoVideo,
  GEMINI_VIDEO_BASE,
  VEO_3_1_LITE,
} from "../skills/_shared/lib/veo.ts";
import { planVeoLiteSegments } from "../skills/make-cheap-video/scripts/stitch.ts";

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

describe("Veo request builder", () => {
  test("defaults to an 8s 720p 16:9 Veo payload with numeric duration", () => {
    const body = buildVeoPredictBody({ prompt: "make a clip" });
    expect(body).toEqual({
      instances: [{ prompt: "make a clip" }],
      parameters: {
        aspectRatio: "16:9",
        durationSeconds: 8,
        resolution: "720p",
      },
    });
    expect(typeof (body.parameters as Record<string, unknown>).durationSeconds).toBe("number");
  });

  test("rejects unsupported Lite durations before hitting the API", () => {
    expect(() =>
      buildVeoPredictBody({ prompt: "too long", durationSeconds: 15 as never }),
    ).toThrow("durationSeconds");
  });
});

describe("generateVeoVideo", () => {
  test("submits, polls the long-running operation, then downloads the mp4", async () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x18]);
    const seen = mockFetch((url) => {
      if (url === `${GEMINI_VIDEO_BASE}/models/${VEO_3_1_LITE}:predictLongRunning`) {
        return Response.json({ name: "models/veo/operations/op-1" });
      }
      if (url === `${GEMINI_VIDEO_BASE}/models/veo/operations/op-1`) {
        return Response.json({
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [{ video: { uri: "https://video.example/clip.mp4" } }],
            },
          },
        });
      }
      if (url === "https://video.example/clip.mp4") {
        return new Response(mp4, { headers: { "content-type": "video/mp4" } });
      }
      return new Response("x", { status: 500 });
    });

    const result = await generateVeoVideo(
      { prompt: "cheap video" },
      { apiKey: "test-key", sleep: noSleep },
    );

    expect(result.bytes).toEqual(mp4);
    expect(result.contentType).toBe("video/mp4");
    expect(result.operationName).toBe("models/veo/operations/op-1");

    const submitBody = JSON.parse(seen.calls[0]!.init.body as string);
    expect(submitBody.parameters.durationSeconds).toBe(8);
    expect(seen.calls[0]!.init.headers).toMatchObject({ "x-goog-api-key": "test-key" });
  });
});

describe("cheap-video segment planning", () => {
  test("defaults a 15s target to two 8s Veo Lite generations", () => {
    expect(planVeoLiteSegments(15)).toEqual([8, 8]);
  });

  test("uses the smallest supported single segment for shorter targets", () => {
    expect(planVeoLiteSegments(4)).toEqual([4]);
    expect(planVeoLiteSegments(5)).toEqual([6]);
    expect(planVeoLiteSegments(8)).toEqual([8]);
  });
});
