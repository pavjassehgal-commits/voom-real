import "server-only";
import { AiError } from "./types";

export interface AiConfig {
  provider: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
}

export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_AI_REQUEST_TIMEOUT_MS = 120_000;

function requestTimeoutMs(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) return DEFAULT_AI_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AiError("not_configured", "MARA's AI request timeout is invalid.");
  }
  return Math.min(parsed, MAX_AI_REQUEST_TIMEOUT_MS);
}

const PROVIDER_DEFAULTS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  nvidia: "https://integrate.api.nvidia.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/** The vision call answers per image; it should never hold an upload screen for long. */
export const DEFAULT_AI_VISION_TIMEOUT_MS = 20_000;

/**
 * MARA's image reading (Brand Kit v2, slice 5): a SEPARATE, optional model
 * that accepts images. Nothing is configured until `AI_VISION_MODEL` is set;
 * then the owner's typed lines are prefilled instead of empty.
 *
 *   AI_VISION_MODEL     required, e.g. a Gemini Flash or Llama 4 Scout model
 *   AI_VISION_PROVIDER  defaults to AI_PROVIDER (groq, openai, gemini, openrouter, ...)
 *   AI_VISION_API_KEY   defaults to OPENROUTER_API_KEY for openrouter, else AI_API_KEY
 *                       when the provider is the same as AI_PROVIDER
 *   AI_VISION_BASE_URL  defaults to the provider's URL (or AI_BASE_URL for the same provider)
 */
export function getAiVisionConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const model = env.AI_VISION_MODEL?.trim();
  if (!model) throw new AiError("not_configured", "MARA's image reading is not configured.");
  const textProvider = env.AI_PROVIDER?.trim().toLowerCase() || "groq";
  const provider = env.AI_VISION_PROVIDER?.trim().toLowerCase() || textProvider;
  const sameProvider = provider === textProvider;
  const apiKey = env.AI_VISION_API_KEY?.trim()
    || (provider === "openrouter" ? env.OPENROUTER_API_KEY?.trim() : undefined)
    || (sameProvider ? env.AI_API_KEY?.trim() : undefined);
  const baseUrl = (env.AI_VISION_BASE_URL?.trim() || (sameProvider ? env.AI_BASE_URL?.trim() : "") || PROVIDER_DEFAULTS[provider])?.replace(/\/$/, "");
  if ((provider !== "local" && !apiKey) || !baseUrl) {
    throw new AiError("not_configured", "MARA's image reading is not configured.");
  }
  return { provider, apiKey, baseUrl, model, requestTimeoutMs: DEFAULT_AI_VISION_TIMEOUT_MS };
}

/** True when image reading can run. Never throws; reads no secret into the result. */
export function isAiVisionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    getAiVisionConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function getAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const provider = env.AI_PROVIDER?.trim().toLowerCase() || "groq";
  const apiKey = env.AI_API_KEY?.trim();
  const model = env.AI_MODEL?.trim();
  const baseUrl = (env.AI_BASE_URL?.trim() || PROVIDER_DEFAULTS[provider])?.replace(/\/$/, "");
  const timeoutMs = requestTimeoutMs(env.AI_REQUEST_TIMEOUT_MS);

  const requiresApiKey = provider !== "local";
  if ((requiresApiKey && !apiKey) || !model || !baseUrl) {
    throw new AiError("not_configured", "MARA's AI provider is not configured.");
  }

  return { provider, apiKey, baseUrl, model, requestTimeoutMs: timeoutMs };
}
