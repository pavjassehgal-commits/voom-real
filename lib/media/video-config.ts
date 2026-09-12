import "server-only";
import { getMediaConfig } from "./config";
import { MediaError } from "./types";

/**
 * Video generation provider configuration.
 *
 * Secrets are server-side only: the key is read from the environment on every
 * call, never persisted, never returned to the client and never logged.
 *
 * Precedence (documented for the production setup checklist):
 *   1. VIDEO_PROVIDER set -> that provider. OpenRouter video uses the existing
 *      OPENROUTER_API_KEY; Magic Hour continues to use VIDEO_API_KEY.
 *   2. VIDEO_PROVIDER unset -> fall back to MEDIA_PROVIDER (gemini/openai)
 *      when it is configured, so existing deployments keep working.
 *   3. Neither configured -> MediaError("not_configured"); the UI degrades
 *      to the truthful "Create with MARA is temporarily unavailable" state
 *      while image generation and all publishing keep working.
 *
 * OpenRouter is deliberately explicit for video. MEDIA_PROVIDER=openrouter
 * remains image-only, so adding Seedream never silently changes the video
 * provider. Set VIDEO_PROVIDER=openrouter to opt into Seedance video.
 */
export interface VideoConfig {
  provider: "magic-hour" | "gemini" | "openai" | "openrouter";
  apiKey: string;
  baseUrl: string;
  /** Model id passed to the provider when set. */
  model: string | null;
  /** Provider output resolution; V1 production defaults to 720p. */
  resolution: string;
  /** Provider video duration; OpenRouter V1 defaults to six seconds. */
  durationSeconds: number | null;
  /** True when this provider can animate a reference image (image-to-video). */
  supportsImageToVideo: boolean;
  /** True when this provider can generate video from a text prompt alone. */
  supportsTextToVideo: boolean;
}

const MAGIC_HOUR_DEFAULT_URL = "https://api.magichour.ai";
const GEMINI_DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_DEFAULT_URL = "https://api.openai.com/v1";
const OPENROUTER_DEFAULT_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MODEL = "bytedance/seedance-2.0-mini";

export function getVideoConfig(env: NodeJS.ProcessEnv = process.env): VideoConfig {
  const raw = env.VIDEO_PROVIDER?.trim().toLowerCase();
  if (raw && raw !== "magic-hour" && raw !== "gemini" && raw !== "openai" && raw !== "openrouter") {
    throw new MediaError("not_configured");
  }

  if (raw === "openrouter") {
    // This is intentionally not VIDEO_API_KEY or MEDIA_API_KEY. The existing
    // production OpenRouter secret is the only credential used for Seedream
    // and Seedance, and it never leaves this server-only module.
    const key = env.OPENROUTER_API_KEY?.trim();
    if (!key) throw new MediaError("not_configured");
    const baseUrl = (env.VIDEO_BASE_URL?.trim() || OPENROUTER_DEFAULT_URL).replace(/\/$/, "");
    return {
      provider: "openrouter",
      apiKey: key,
      baseUrl,
      model: env.VIDEO_MODEL?.trim() || OPENROUTER_DEFAULT_MODEL,
      resolution: "720p",
      durationSeconds: 6,
      supportsImageToVideo: true,
      supportsTextToVideo: true,
    };
  }

  if (raw === "magic-hour") {
    const key = env.VIDEO_API_KEY?.trim();
    if (!key) throw new MediaError("not_configured");
    const baseUrl = (env.VIDEO_BASE_URL?.trim() || MAGIC_HOUR_DEFAULT_URL).replace(/\/$/, "");
    return {
      provider: "magic-hour",
      apiKey: key,
      baseUrl,
      model: env.VIDEO_MODEL?.trim() || null,
      resolution: "720p",
      durationSeconds: null,
      supportsImageToVideo: true,
      supportsTextToVideo: true,
    };
  }

  // Explicit gemini/openai video path — independent of the image provider so
  // MEDIA_PROVIDER=openrouter does not block VIDEO_PROVIDER=gemini|openai.
  if (raw === "gemini" || raw === "openai") {
    const key = env.VIDEO_API_KEY?.trim() || env.MEDIA_API_KEY?.trim();
    if (!key) throw new MediaError("not_configured");
    const defaults = { gemini: GEMINI_DEFAULT_URL, openai: OPENAI_DEFAULT_URL } as const;
    const baseUrl = (env.VIDEO_BASE_URL?.trim() || env.MEDIA_BASE_URL?.trim() || defaults[raw]).replace(/\/$/, "");
    return {
      provider: raw,
      apiKey: key,
      baseUrl,
      model: env.VIDEO_MODEL?.trim() || env.MEDIA_VIDEO_MODEL?.trim() || null,
      resolution: "720p",
      durationSeconds: null,
      supportsImageToVideo: false,
      supportsTextToVideo: true,
    };
  }

  // Inherit from MEDIA_PROVIDER only when it is gemini/openai. OpenRouter is
  // image-only here and must be selected explicitly with VIDEO_PROVIDER.
  const mediaHint = env.MEDIA_PROVIDER?.trim().toLowerCase();
  if (mediaHint !== "gemini" && mediaHint !== "openai") throw new MediaError("not_configured");

  const media = getMediaConfig(env);
  if (media.provider !== "gemini" && media.provider !== "openai") throw new MediaError("not_configured");
  const key = env.VIDEO_API_KEY?.trim() || media.apiKey;
  if (!key) throw new MediaError("not_configured");
  return {
    provider: media.provider,
    apiKey: key,
    baseUrl: media.baseUrl,
    model: media.videoModel,
    resolution: "720p",
    durationSeconds: null,
    supportsImageToVideo: false,
    supportsTextToVideo: true,
  };
}

/**
 * Provider display + capability flag exposed to the client (safe subset only:
 * never keys, never provider job ids, never storage paths).
 */
export function videoCapabilities(config: VideoConfig) {
  return {
    provider: config.provider,
    imageToVideo: config.supportsImageToVideo,
    textToVideo: config.supportsTextToVideo,
  };
}
