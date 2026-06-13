// fal.ts — fal.ai queue client for distillery's make-clip skill: image
// generation (GPT Image 2), reference-to-video (Seedance 2.0), and the file
// storage upload the video stage needs for its @ImageN references.
//
// Mirrors the gemini.ts / tts.ts shape: pure request-building helpers that
// tests pin without a network, plus thin async callers that resolve the key
// through the secrets fallback chain unless an explicit apiKey is passed.
//
// LIVE-VERIFIED 2026-06-12 (prototypes/make-clip/output/RUN-LOG.md — two full
// prototype rounds against the real API). Facts encoded here, do not
// re-discover:
//   - queue API at https://queue.fal.run/<endpoint> : POST submit returns
//     { request_id, status_url, response_url }; poll status_url (?logs=1)
//     until status === "COMPLETED" (FAILED/ERROR is terminal); then GET
//     response_url for the result body.
//   - storage upload host is https://rest.alpha.fal.ai (NOT rest.fal.run,
//     which does not resolve): POST /storage/upload/initiate?storage_type=
//     fal-cdn-v3 with { content_type, file_name } returns { upload_url,
//     file_url }; PUT the bytes to upload_url; file_url is the public ref.
//   - image model "openai/gpt-image-2" (alias "fal-ai/gpt-image-2" also
//     resolves; there is NO "/text-to-image" sub-path): image_size takes a
//     preset string OR { width, height } (multiples of 16, max edge 3840,
//     max 8,294,400 px); quality "auto"|"low"|"medium"|"high".
//   - video model "bytedance/seedance-2.0/reference-to-video": image_urls
//     (up to 9, referenced in the prompt as @Image1…@Image9); duration is a
//     STRING enum "4"–"15" or "auto"; resolution "480p"|"720p"|"1080p"
//     (1080p is the quality lever); aspect_ratio incl. "1:1"|"9:16"|"16:9";
//     generate_audio bool (free — does not change cost); optional seed.
//   - auth header is `Authorization: Key <FAL_KEY>`; key via
//     getSecret("FAL_KEY").

import { getSecret } from "./secrets.ts";

export const QUEUE_BASE = "https://queue.fal.run";
export const STORAGE_BASE = "https://rest.alpha.fal.ai";

export const GPT_IMAGE_2 = "openai/gpt-image-2";
export const SEEDANCE_2 = "bytedance/seedance-2.0/reference-to-video";

/** fal image_size: a named preset or an explicit pixel box. */
export type ImageSize =
  | string
  | { width: number; height: number };

export type ImageQuality = "auto" | "low" | "medium" | "high";

/**
 * Seedance duration is a string enum on the wire, not a number: "4"–"15" or
 * "auto". VALID_DURATIONS is the single source of truth shared by both the
 * library guard (buildVideoRequestBody) and the generate-video CLI parser.
 */
export const VALID_DURATIONS = [
  "4", "5", "6", "7", "8", "9", "10",
  "11", "12", "13", "14", "15", "auto",
] as const;

export type VideoDuration = (typeof VALID_DURATIONS)[number];

/** Type guard: is `v` one of the Seedance-supported duration values? */
export function isValidDuration(v: unknown): v is VideoDuration {
  return typeof v === "string" && (VALID_DURATIONS as readonly string[]).includes(v);
}

export type VideoResolution = "480p" | "720p" | "1080p";

/** Seedance-supported aspect ratios (the ones make-clip exposes). */
export type AspectRatio = "1:1" | "9:16" | "16:9";

const MAX_EDGE = 3840;
const MAX_PIXELS = 8_294_400; // 3840 * 2160
const MAX_IMAGE_URLS = 9;

/**
 * Typed fal error so callers can branch on auth vs everything else — mirrors
 * make-podcast's AuthError stance (a 401/403 is "fix your key", not a retry).
 */
export class FalError extends Error {
  readonly status?: number;
  readonly stage: string;
  constructor(message: string, opts: { status?: number; stage: string }) {
    super(message);
    this.name = "FalError";
    this.status = opts.status;
    this.stage = opts.stage;
  }
  /** A 401/403 means the FAL_KEY is missing/invalid — not retryable. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

async function resolveKey(apiKey?: string): Promise<string> {
  return apiKey?.trim() || getSecret("FAL_KEY");
}

function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Key ${key}`, "Content-Type": "application/json" };
}

// ---------------------------------------------------------------------------
// Request-body builders (pure — tests pin these without a network)
// ---------------------------------------------------------------------------

export interface ImageRequest {
  prompt: string;
  /** Preset string or { width, height }. Defaults to 1:1 1024x1024. */
  imageSize?: ImageSize;
  /** Defaults to "high" — the prototype's verified quality lever. */
  quality?: ImageQuality;
}

/** Validate the pixel box against the documented GPT Image 2 limits. */
export function validateImageSize(size: ImageSize): void {
  if (typeof size === "string") {
    if (!size.trim()) throw new Error("fal image: image_size preset must be non-empty");
    return;
  }
  const { width, height } = size;
  for (const [name, v] of [["width", width], ["height", height]] as const) {
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error(`fal image: ${name} must be a positive integer, got ${v}`);
    }
    if (v % 16 !== 0) {
      throw new Error(`fal image: ${name} must be a multiple of 16, got ${v}`);
    }
    if (v > MAX_EDGE) {
      throw new Error(`fal image: ${name} ${v} exceeds max edge ${MAX_EDGE}`);
    }
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `fal image: ${width}x${height} = ${width * height}px exceeds max ${MAX_PIXELS}px`,
    );
  }
}

export function buildImageRequestBody(req: ImageRequest): Record<string, unknown> {
  if (!req.prompt.trim()) throw new Error("fal image: prompt must be non-empty");
  const imageSize: ImageSize = req.imageSize ?? { width: 1024, height: 1024 };
  validateImageSize(imageSize);
  return {
    prompt: req.prompt,
    image_size: imageSize,
    quality: req.quality ?? "high",
  };
}

export interface VideoRequest {
  prompt: string;
  /** Reference image URLs (fal storage), referenced in prompt as @Image1… */
  imageUrls: string[];
  /** String enum "4"–"15"|"auto". Defaults to "15". */
  duration?: VideoDuration;
  /** "480p"|"720p"|"1080p". Defaults to "720p" (retry-headroom default). */
  resolution?: VideoResolution;
  /** "1:1"|"9:16"|"16:9". Defaults to "1:1" (feed-native square). */
  aspectRatio?: AspectRatio;
  /** Diegetic audio is free; defaults to true. */
  generateAudio?: boolean;
  /** Optional deterministic seed. */
  seed?: number;
}

export function buildVideoRequestBody(req: VideoRequest): Record<string, unknown> {
  if (!req.prompt.trim()) throw new Error("fal video: prompt must be non-empty");
  if (!Array.isArray(req.imageUrls) || req.imageUrls.length === 0) {
    throw new Error("fal video: at least one image_url reference is required");
  }
  if (req.imageUrls.length > MAX_IMAGE_URLS) {
    throw new Error(
      `fal video: at most ${MAX_IMAGE_URLS} image_urls, got ${req.imageUrls.length}`,
    );
  }
  for (const url of req.imageUrls) {
    if (typeof url !== "string" || !url.trim()) {
      throw new Error("fal video: every image_url must be a non-empty string");
    }
  }
  // Defensive: never put an out-of-enum duration on the wire, regardless of
  // caller (the CLI validates too, but the library must be safe standalone).
  if (req.duration !== undefined && !isValidDuration(req.duration)) {
    throw new FalError(
      `fal video: duration must be one of ${VALID_DURATIONS.join(", ")}, got ${JSON.stringify(req.duration)}`,
      { stage: SEEDANCE_2 },
    );
  }
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    image_urls: req.imageUrls,
    duration: req.duration ?? "15",
    resolution: req.resolution ?? "720p",
    aspect_ratio: req.aspectRatio ?? "1:1",
    generate_audio: req.generateAudio ?? true,
  };
  if (req.seed !== undefined) body.seed = req.seed;
  return body;
}

// ---------------------------------------------------------------------------
// Queue plumbing
// ---------------------------------------------------------------------------

export interface QueueSubmission {
  request_id: string;
  status_url: string;
  response_url: string;
}

export interface MediaRef {
  url: string;
  content_type?: string;
}

export interface QueueResult {
  request_id: string;
  /** Every media URL found anywhere in the response, in walk order. */
  media: MediaRef[];
  /** The raw response body for stage-specific fields (seed, timings, …). */
  raw: Record<string, unknown>;
}

/** Recursively collect every { url } object that looks like an http(s) media ref. */
export function collectMediaUrls(value: unknown): MediaRef[] {
  const out: MediaRef[] = [];
  const walk = (o: unknown): void => {
    if (o && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      if (typeof rec.url === "string" && /^https?:/.test(rec.url)) {
        out.push({
          url: rec.url,
          content_type:
            typeof rec.content_type === "string" ? rec.content_type : undefined,
        });
      }
      for (const v of Object.values(rec)) walk(v);
    }
  };
  walk(value);
  return out;
}

export interface RunOptions {
  apiKey?: string;
  /** Poll interval in ms (default 4000). */
  pollIntervalMs?: number;
  /** Overall timeout in ms (default 30 min). */
  timeoutMs?: number;
  /** Injectable clock/sleep for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Called on each poll with the raw status body (for progress logging). */
  onStatus?: (status: string, body: Record<string, unknown>) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Submit a job to the fal queue, poll status_url to completion, fetch and
 * return the response body + every media URL it contains. Throws FalError on
 * submit/poll/fetch failures and on terminal FAILED/ERROR status.
 */
export async function runQueueJob(
  endpoint: string,
  input: Record<string, unknown>,
  opts: RunOptions = {},
): Promise<QueueResult> {
  const key = await resolveKey(opts.apiKey);
  const headers = authHeaders(key);
  const sleep = opts.sleep ?? defaultSleep;
  const pollIntervalMs = opts.pollIntervalMs ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const stage = endpoint;

  const submitRes = await fetch(`${QUEUE_BASE}/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => submitRes.statusText);
    throw new FalError(`submit ${submitRes.status}: ${text.slice(0, 500)}`, {
      status: submitRes.status,
      stage,
    });
  }
  const submitted = (await submitRes.json()) as Partial<QueueSubmission>;
  if (!submitted.status_url || !submitted.response_url) {
    throw new FalError("submit: response missing status_url/response_url", { stage });
  }

  const started = Date.now();
  for (;;) {
    // Check the deadline at the TOP, before any fetch or sleep: a timeoutMs<=0
    // bails immediately with no network call, and the deadline never overshoots
    // by a full poll interval + round-trip.
    if (Date.now() - started > timeoutMs) {
      throw new FalError(`timeout after ${Math.round(timeoutMs / 1000)}s`, { stage });
    }
    // Fetch first (an already-complete job is detected without an upfront
    // sleep), then sleep before the next iteration.
    const sRes = await fetch(`${submitted.status_url}?logs=1`, { headers });
    if (!sRes.ok) {
      const text = await sRes.text().catch(() => sRes.statusText);
      throw new FalError(`status ${sRes.status}: ${text.slice(0, 500)}`, {
        status: sRes.status,
        stage,
      });
    }
    const body = (await sRes.json()) as Record<string, unknown>;
    const status = String(body.status ?? "");
    opts.onStatus?.(status, body);
    if (status === "COMPLETED") break;
    if (status === "FAILED" || status === "ERROR") {
      throw new FalError(
        `job ${status}: ${JSON.stringify(body).slice(0, 800)}`,
        { stage },
      );
    }
    await sleep(pollIntervalMs);
  }

  const rRes = await fetch(submitted.response_url, { headers });
  if (!rRes.ok) {
    const text = await rRes.text().catch(() => rRes.statusText);
    throw new FalError(`response ${rRes.status}: ${text.slice(0, 500)}`, {
      status: rRes.status,
      stage,
    });
  }
  const raw = (await rRes.json()) as Record<string, unknown>;
  return {
    request_id: submitted.request_id ?? "",
    media: collectMediaUrls(raw),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Storage upload (for the video stage's @ImageN references)
// ---------------------------------------------------------------------------

/** Guess a content type from a file name extension (png/jpg/webp/mp4). */
export function contentTypeFor(fileName: string): string {
  const n = fileName.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

export interface UploadInitiateResponse {
  upload_url: string;
  file_url: string;
}

/**
 * Upload bytes to fal storage and return the public file_url. Two-step:
 * initiate (get a presigned upload_url + the public file_url), then PUT the
 * bytes. Host is rest.alpha.fal.ai (rest.fal.run does not resolve).
 */
export async function uploadToFalStorage(
  bytes: Uint8Array,
  fileName: string,
  opts: { apiKey?: string; contentType?: string } = {},
): Promise<string> {
  const key = await resolveKey(opts.apiKey);
  const contentType = opts.contentType ?? contentTypeFor(fileName);

  const initRes = await fetch(
    `${STORAGE_BASE}/storage/upload/initiate?storage_type=fal-cdn-v3`,
    {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ content_type: contentType, file_name: fileName }),
    },
  );
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => initRes.statusText);
    throw new FalError(`upload initiate ${initRes.status}: ${text.slice(0, 500)}`, {
      status: initRes.status,
      stage: "storage-upload",
    });
  }
  const init = (await initRes.json()) as Partial<UploadInitiateResponse>;
  if (!init.upload_url || !init.file_url) {
    throw new FalError("upload initiate: response missing upload_url/file_url", {
      stage: "storage-upload",
    });
  }

  const putRes = await fetch(init.upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes as unknown as BodyInit,
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => putRes.statusText);
    throw new FalError(`upload PUT ${putRes.status}: ${text.slice(0, 500)}`, {
      status: putRes.status,
      stage: "storage-upload",
    });
  }
  return init.file_url;
}

// ---------------------------------------------------------------------------
// High-level stage callers
// ---------------------------------------------------------------------------

export interface GeneratedMedia {
  bytes: Uint8Array;
  contentType: string;
  url: string;
  request_id: string;
  raw: Record<string, unknown>;
}

async function downloadMedia(ref: MediaRef): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetch(ref.url);
  if (!res.ok) {
    throw new FalError(`media download ${res.status}: ${ref.url}`, {
      status: res.status,
      stage: "download",
    });
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const contentType =
    ref.content_type ?? res.headers.get("content-type") ?? "application/octet-stream";
  return { bytes: buf, contentType };
}

/** Generate one image via GPT Image 2 and return its bytes. */
export async function generateImage(
  req: ImageRequest,
  opts: RunOptions = {},
): Promise<GeneratedMedia> {
  const body = buildImageRequestBody(req);
  const result = await runQueueJob(GPT_IMAGE_2, body, opts);
  const first = result.media[0];
  if (!first) {
    throw new FalError("image: response contained no media URL", { stage: GPT_IMAGE_2 });
  }
  const { bytes, contentType } = await downloadMedia(first);
  return { bytes, contentType, url: first.url, request_id: result.request_id, raw: result.raw };
}

/** Generate one video via Seedance 2.0 reference-to-video and return its bytes. */
export async function generateVideo(
  req: VideoRequest,
  opts: RunOptions = {},
): Promise<GeneratedMedia> {
  const body = buildVideoRequestBody(req);
  const result = await runQueueJob(SEEDANCE_2, body, opts);
  const video = result.media.find((m) => /mp4/.test(m.content_type ?? "") || /\.mp4(\?|$)/.test(m.url))
    ?? result.media[0];
  if (!video) {
    throw new FalError("video: response contained no media URL", { stage: SEEDANCE_2 });
  }
  const { bytes, contentType } = await downloadMedia(video);
  return { bytes, contentType, url: video.url, request_id: result.request_id, raw: result.raw };
}
