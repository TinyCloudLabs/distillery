// veo.ts — Gemini/Veo video generation helper for the cheap-video skill.
//
// Mirrors the fal.ts shape: pure request builders for tests, plus a thin
// long-running-operation caller that resolves GEMINI_API_KEY through the
// shared secrets fallback chain. Veo 3.1 Lite is cheap, but currently limited
// to 4/6/8 second generations, so 15s clips are built from multiple segments
// by the skill-level stitcher.

import { getSecret } from "./secrets.ts";

export const GEMINI_VIDEO_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const VEO_3_1_LITE = "veo-3.1-lite-generate-preview";

export const VEO_DURATIONS = [4, 6, 8] as const;
export type VeoDuration = (typeof VEO_DURATIONS)[number];
export type VeoAspectRatio = "16:9" | "9:16";
export type VeoResolution = "720p" | "1080p";

export class VeoError extends Error {
  readonly status?: number;
  readonly stage: string;
  constructor(message: string, opts: { status?: number; stage: string }) {
    super(message);
    this.name = "VeoError";
    this.status = opts.status;
    this.stage = opts.stage;
  }
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

async function resolveKey(apiKey?: string): Promise<string> {
  return apiKey?.trim() || getSecret("GEMINI_API_KEY");
}

export interface VeoVideoRequest {
  prompt: string;
  /** Defaults to Veo 3.1 Lite. */
  model?: string;
  /** Veo 3.1 Lite supports 4, 6, or 8 seconds. Defaults to 8. */
  durationSeconds?: VeoDuration;
  /** Defaults to 720p for the cheap path. */
  resolution?: VeoResolution;
  /** Defaults to 16:9. Veo does not currently expose 1:1. */
  aspectRatio?: VeoAspectRatio;
  /** Optional seed; improves repeatability but does not guarantee it. */
  seed?: number;
}

export function isValidVeoDuration(v: unknown): v is VeoDuration {
  return typeof v === "number" && (VEO_DURATIONS as readonly number[]).includes(v);
}

export function buildVeoPredictBody(req: VeoVideoRequest): Record<string, unknown> {
  if (!req.prompt.trim()) throw new Error("veo video: prompt must be non-empty");
  const durationSeconds = req.durationSeconds ?? 8;
  if (!isValidVeoDuration(durationSeconds)) {
    throw new Error(
      `veo video: durationSeconds must be one of ${VEO_DURATIONS.join(", ")}, got ${durationSeconds}`,
    );
  }

  const parameters: Record<string, unknown> = {
    aspectRatio: req.aspectRatio ?? "16:9",
    durationSeconds,
    resolution: req.resolution ?? "720p",
  };
  if (req.seed !== undefined) parameters.seed = req.seed;

  return {
    instances: [{ prompt: req.prompt }],
    parameters,
  };
}

function videoUriFromOperation(body: Record<string, unknown>): string | undefined {
  const response = body.response as Record<string, unknown> | undefined;
  const generateVideoResponse = response?.generateVideoResponse as
    | Record<string, unknown>
    | undefined;
  const samples = generateVideoResponse?.generatedSamples as unknown[] | undefined;
  const sampleVideo = (samples?.[0] as Record<string, unknown> | undefined)?.video as
    | Record<string, unknown>
    | undefined;
  if (typeof sampleVideo?.uri === "string") return sampleVideo.uri;

  const generatedVideos = response?.generatedVideos as unknown[] | undefined;
  const generatedVideo = (generatedVideos?.[0] as Record<string, unknown> | undefined)?.video as
    | Record<string, unknown>
    | undefined;
  if (typeof generatedVideo?.uri === "string") return generatedVideo.uri;

  return undefined;
}

export interface GenerateVeoOptions {
  apiKey?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (body: Record<string, unknown>) => void;
}

export interface GeneratedVeoVideo {
  bytes: Uint8Array;
  contentType: string;
  operationName: string;
  raw: Record<string, unknown>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function generateVeoVideo(
  req: VeoVideoRequest,
  opts: GenerateVeoOptions = {},
): Promise<GeneratedVeoVideo> {
  const apiKey = await resolveKey(opts.apiKey);
  const model = req.model ?? VEO_3_1_LITE;
  const body = buildVeoPredictBody(req);
  const headers = {
    "x-goog-api-key": apiKey,
    "content-type": "application/json",
  };

  const submitRes = await fetch(`${GEMINI_VIDEO_BASE}/models/${model}:predictLongRunning`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => submitRes.statusText);
    throw new VeoError(`submit ${submitRes.status}: ${text.slice(0, 800)}`, {
      status: submitRes.status,
      stage: model,
    });
  }
  const submitted = (await submitRes.json()) as Record<string, unknown>;
  const operationName = typeof submitted.name === "string" ? submitted.name : "";
  if (!operationName) {
    throw new VeoError("submit: response missing operation name", { stage: model });
  }

  const sleep = opts.sleep ?? defaultSleep;
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const started = Date.now();

  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new VeoError(`timeout after ${Math.round(timeoutMs / 1000)}s`, { stage: model });
    }

    const statusRes = await fetch(`${GEMINI_VIDEO_BASE}/${operationName}`, { headers });
    if (!statusRes.ok) {
      const text = await statusRes.text().catch(() => statusRes.statusText);
      throw new VeoError(`status ${statusRes.status}: ${text.slice(0, 800)}`, {
        status: statusRes.status,
        stage: model,
      });
    }

    const statusBody = (await statusRes.json()) as Record<string, unknown>;
    opts.onStatus?.(statusBody);
    if (statusBody.error) {
      throw new VeoError(`operation error: ${JSON.stringify(statusBody.error).slice(0, 800)}`, {
        stage: model,
      });
    }
    if (statusBody.done === true) {
      const uri = videoUriFromOperation(statusBody);
      if (!uri) {
        throw new VeoError("operation completed without a downloadable video uri", {
          stage: model,
        });
      }
      const videoRes = await fetch(uri, { headers });
      if (!videoRes.ok) {
        const text = await videoRes.text().catch(() => videoRes.statusText);
        throw new VeoError(`download ${videoRes.status}: ${text.slice(0, 800)}`, {
          status: videoRes.status,
          stage: model,
        });
      }
      return {
        bytes: new Uint8Array(await videoRes.arrayBuffer()),
        contentType: videoRes.headers.get("content-type") ?? "video/mp4",
        operationName,
        raw: statusBody,
      };
    }

    await sleep(pollIntervalMs);
  }
}
