import "server-only";
import { AiError } from "./types";

export interface AiConfig {
  provider: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
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

  const requiresApiKey = provider !== "local";
  if ((requiresApiKey && !apiKey) || !model || !baseUrl) {
    throw new AiError("not_configured", "MARA's AI provider is not configured.");
  }

  return { provider, apiKey, baseUrl, model };
}
