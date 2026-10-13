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
};

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
