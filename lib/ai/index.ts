import "server-only";
import { getAiConfig } from "./config";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import { AiError, type AiProvider } from "./types";
import { createUsageRecorder } from "./usage";

export function createAiProvider(): AiProvider {
  const config = getAiConfig();
  if (["groq", "openai", "gemini", "nvidia", "local", "openai-compatible"].includes(config.provider)) {
    return new OpenAiCompatibleProvider(config, createUsageRecorder());
  }
  throw new AiError("not_configured", `Unsupported AI provider: ${config.provider}`);
}

export { AiError } from "./types";
export type { AiJsonSchemaSpec, AiMessage, AiProvider, AiRequest, AiStructuredRequest, AiToolMessage, AiToolDefinition, AiToolDecision } from "./types";
export type { AiUsageContext, AiUsageCategory, ProviderUsageAttempt } from "./usage";
