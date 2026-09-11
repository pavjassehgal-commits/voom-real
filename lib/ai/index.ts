import "server-only";
import { getAiConfig } from "./config";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import { AiError, type AiProvider } from "./types";

export function createAiProvider(): AiProvider {
  const config = getAiConfig();
  if (["groq", "openai", "gemini", "nvidia", "local", "openai-compatible"].includes(config.provider)) {
    return new OpenAiCompatibleProvider(config);
  }
  throw new AiError("not_configured", `Unsupported AI provider: ${config.provider}`);
}

export { AiError } from "./types";
export type { AiJsonSchemaSpec, AiMessage, AiProvider, AiRequest, AiStructuredRequest, AiToolMessage, AiToolDefinition, AiToolDecision } from "./types";
