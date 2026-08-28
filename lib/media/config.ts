import "server-only";
import { MediaError } from "./types";

export interface MediaConfig {
  provider: "gemini" | "openai";
  apiKey: string;
  baseUrl: string;
  imageModel: string;
  videoModel: string;
}

const DEFAULT_URLS = {
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
} as const;

export function getMediaConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  const rawProvider = env.MEDIA_PROVIDER?.trim().toLowerCase();
  if (rawProvider !== "gemini" && rawProvider !== "openai") throw new MediaError("not_configured");
  const apiKey = env.MEDIA_API_KEY?.trim();
  const imageModel = env.MEDIA_IMAGE_MODEL?.trim();
  const videoModel = env.MEDIA_VIDEO_MODEL?.trim();
  const baseUrl = (env.MEDIA_BASE_URL?.trim() || DEFAULT_URLS[rawProvider]).replace(/\/$/, "");
  if (!apiKey || !imageModel || !videoModel) throw new MediaError("not_configured");
  return { provider: rawProvider, apiKey, baseUrl, imageModel, videoModel };
}
