export interface MediaReadiness {
  images: {
    enabled: boolean;
    reason: string;
  };
  audio: {
    enabled: boolean;
    reason: string;
  };
  video: {
    enabled: boolean;
    reason: string;
  };
}

function providerEnabled(env: NodeJS.ProcessEnv, ...names: string[]): boolean {
  return names.some((name) => Boolean(env[name]?.trim()));
}

export function buildMediaReadiness(env: NodeJS.ProcessEnv = process.env): MediaReadiness {
  const geminiProviderConfigured = providerEnabled(
    env,
    "GOOGLE_AI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  );
  const falVideoProviderConfigured = providerEnabled(env, "FAL_KEY");
  const videoProviderConfigured = falVideoProviderConfigured || geminiProviderConfigured;
  const videoFlagEnabled = env.AGENT_ENABLE_VIDEO === "1";

  return {
    images: {
      enabled: geminiProviderConfigured,
      reason: geminiProviderConfigured ? "image provider configured" : "image provider not configured",
    },
    audio: {
      enabled: geminiProviderConfigured,
      reason: geminiProviderConfigured ? "Gemini provider configured for TTS" : "Gemini provider not configured",
    },
    video: {
      enabled: videoProviderConfigured && videoFlagEnabled,
      reason: videoProviderConfigured
        ? videoFlagEnabled
          ? falVideoProviderConfigured
            ? "FAL video provider configured and enabled"
            : "Gemini/Veo video provider configured and enabled"
          : "video provider configured, but AGENT_ENABLE_VIDEO=1 is not enabled"
        : "video provider not configured",
    },
  };
}
