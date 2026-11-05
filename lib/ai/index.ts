import "server-only";
import { getAiConfig, getAiVisionConfig, type AiConfig } from "./config";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import { AiError, type AiProvider } from "./types";
import { createUsageRecorder } from "./usage";

const SUPPORTED_PROVIDERS = ["groq", "openai", "gemini", "nvidia", "openrouter", "local", "openai-compatible"];

// Both the text model and the optional vision model (Brand Kit v2) go through the same
// OpenAI-compatible client; main's usage recorder tracks cost for every call.
function providerFor(config: AiConfig): AiProvider {
  if (SUPPORTED_PROVIDERS.includes(config.provider)) {
    return new OpenAiCompatibleProvider(config, createUsageRecorder());
  }
  throw new AiError("not_configured", `Unsupported AI provider: ${config.provider}`);
}

export function createAiProvider(): AiProvider {
  return providerFor(getAiConfig());
}

/** The optional image-reading model (AI_VISION_*). Throws not_configured when it is not set up. */
export function createAiVisionProvider(): AiProvider {
  return providerFor(getAiVisionConfig());
}

export { isAiVisionConfigured } from "./config";
export { AiError } from "./types";
export type { AiContentPart, AiJsonSchemaSpec, AiMessage, AiProvider, AiRequest, AiStructuredRequest, AiToolMessage, AiToolDefinition, AiToolDecision } from "./types";
export type { AiUsageContext, AiUsageCategory, ProviderUsageAttempt } from "./usage";
