import "server-only";
import { MediaError } from "./types";

export interface MediaConfig {
  provider: "gemini" | "openai" | "openrouter";
  apiKey: string;
  baseUrl: string;
  imageModel: string;
  videoModel: string;
}

const DEFAULT_URLS = {
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
} as const;

const DEFAULT_OPENROUTER_IMAGE_MODEL = "bytedance-seed/seedream-4.5";

/**
 * Image/media provider configuration (server-side only).
 *
 * OpenRouter is the V1 production image provider. It is image-only: the key is
 * OPENROUTER_API_KEY (never MEDIA_API_KEY), video stays on VIDEO_* / Magic Hour,
 * and Gemini/OpenAI remain available as alternate provider implementations.
 */
export function getMediaConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  const rawProvider = env.MEDIA_PROVIDER?.trim().toLowerCase();
  if (rawProvider !== "gemini" && rawProvider !== "openai" && rawProvider !== "openrouter") {
    throw new MediaError("not_configured");
  }

  if (rawProvider === "openrouter") {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    const imageModel = env.MEDIA_IMAGE_MODEL?.trim() || DEFAULT_OPENROUTER_IMAGE_MODEL;
    const baseUrl = (env.MEDIA_BASE_URL?.trim() || DEFAULT_URLS.openrouter).replace(/\/$/, "");
    if (!apiKey) throw new MediaError("not_configured");
    // videoModel is unused for OpenRouter (image-only); keep the field for the
    // shared MediaConfig shape without requiring MEDIA_VIDEO_MODEL.
    return {
      provider: "openrouter",
      apiKey,
      baseUrl,
      imageModel,
      videoModel: env.MEDIA_VIDEO_MODEL?.trim() || "",
    };
  }

  const apiKey = env.MEDIA_API_KEY?.trim();
  const imageModel = env.MEDIA_IMAGE_MODEL?.trim();
  const videoModel = env.MEDIA_VIDEO_MODEL?.trim();
  const baseUrl = (env.MEDIA_BASE_URL?.trim() || DEFAULT_URLS[rawProvider]).replace(/\/$/, "");
  if (!apiKey || !imageModel || !videoModel) throw new MediaError("not_configured");
  return { provider: rawProvider, apiKey, baseUrl, imageModel, videoModel };
}
