import { describe, expect, test } from "bun:test";
import { buildMediaReadiness } from "../harness/agent/src/info.ts";

describe("agent info media readiness", () => {
  test("reports image and podcast audio readiness from Gemini provider aliases", () => {
    const readiness = buildMediaReadiness({
      GOOGLE_AI_API_KEY: "",
      GEMINI_API_KEY: "gemini-test",
    });

    expect(readiness.images).toEqual({
      enabled: true,
      reason: "image provider configured",
    });
    expect(readiness.audio).toEqual({
      enabled: true,
      reason: "Gemini provider configured for TTS",
    });
  });

  test("keeps video disabled until a provider plus AGENT_ENABLE_VIDEO=1 are present", () => {
    expect(buildMediaReadiness({ FAL_KEY: "fal-test" }).video).toEqual({
      enabled: false,
      reason: "video provider configured, but AGENT_ENABLE_VIDEO=1 is not enabled",
    });

    expect(buildMediaReadiness({ FAL_KEY: "fal-test", AGENT_ENABLE_VIDEO: "1" }).video).toEqual({
      enabled: true,
      reason: "FAL video provider configured and enabled",
    });

    expect(
      buildMediaReadiness({ GEMINI_API_KEY: "gemini-test", AGENT_ENABLE_VIDEO: "1" }).video,
    ).toEqual({
      enabled: true,
      reason: "Gemini/Veo video provider configured and enabled",
    });
  });

  test("reports all media providers disabled when no relevant env is configured", () => {
    expect(buildMediaReadiness({})).toEqual({
      images: {
        enabled: false,
        reason: "image provider not configured",
      },
      audio: {
        enabled: false,
        reason: "Gemini provider not configured",
      },
      video: {
        enabled: false,
        reason: "video provider not configured",
      },
    });
  });
});
