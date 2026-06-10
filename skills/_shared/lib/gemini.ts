// Gemini clients for distillery skills: image generation (Nano Banana =
// gemini-2.5-flash-image, lifted from pulse-radio's nano-banana provider)
// and a small text-generation helper. Both resolve their key through the
// secrets fallback chain unless an explicit apiKey is passed.
//
// Cost note: nano-banana images run ~$0.039 / image.

import { getSecret } from "./secrets.ts";

const IMAGE_MODEL = "gemini-2.5-flash-image";
const TEXT_MODEL = "gemini-2.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

async function resolveKey(apiKey?: string): Promise<string> {
  return apiKey?.trim() || getSecret("GEMINI_API_KEY");
}

export interface GenerateImageOptions {
  prompt: string;
  /** e.g. "16:9" (default), "1:1", "9:16". */
  aspectRatio?: string;
  apiKey?: string;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
}

export async function generateImage(
  opts: GenerateImageOptions,
): Promise<GeneratedImage> {
  const apiKey = await resolveKey(opts.apiKey);
  const url = `${API_BASE}/${encodeURIComponent(IMAGE_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const aspect = opts.aspectRatio ?? "16:9";

  const baseBody: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: aspect },
    },
  };

  // Some API versions reject imageConfig/aspectRatio — retry once without it.
  let body = baseBody;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      lastError = `${res.status}: ${text}`;
      if (
        attempt === 0 &&
        (text.includes("imageConfig") || text.includes("aspectRatio"))
      ) {
        const cfg = { ...(baseBody.generationConfig as Record<string, unknown>) };
        delete cfg.imageConfig;
        body = { ...baseBody, generationConfig: cfg };
        continue;
      }
      throw new Error(`gemini image ${lastError}`);
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: unknown[] } }[];
    };
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const inline = (part as { inlineData?: { data?: unknown; mimeType?: unknown } })
        ?.inlineData;
      if (inline?.data && typeof inline.data === "string") {
        const bytes = Uint8Array.from(Buffer.from(inline.data, "base64"));
        const mimeType =
          typeof inline.mimeType === "string" ? inline.mimeType : "image/png";
        return { bytes, mimeType };
      }
    }
    const textOnly = parts
      .map((p) => (p as { text?: unknown })?.text)
      .find((t): t is string => typeof t === "string");
    throw new Error(
      `gemini image: no image in response${textOnly ? ` (text: ${textOnly.slice(0, 200)})` : ""}`,
    );
  }
  throw new Error(`gemini image: ${lastError || "unknown failure"}`);
}

export interface GenerateTextOptions {
  prompt: string;
  /** Defaults to gemini-2.5-flash. */
  model?: string;
  system?: string;
  temperature?: number;
  apiKey?: string;
}

export async function generateText(opts: GenerateTextOptions): Promise<string> {
  const apiKey = await resolveKey(opts.apiKey);
  const model = opts.model ?? TEXT_MODEL;
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
  };
  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] };
  }
  if (opts.temperature !== undefined) {
    body.generationConfig = { temperature: opts.temperature };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`gemini text ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: unknown }[] } }[];
  };
  const out = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("");
  if (!out.trim()) throw new Error("gemini text: empty response");
  return out;
}
