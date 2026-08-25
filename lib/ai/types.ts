export type AiRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface AiRequest {
  messages: AiMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface AiStructuredRequest<T> extends AiRequest {
  parse: (value: unknown) => T;
}

export interface AiToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface AiToolMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export interface AiToolRequest {
  messages: AiToolMessage[];
  tools: AiToolDefinition[];
  maxTokens?: number;
}

export interface AiToolDecision {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  assistantMessage: AiToolMessage;
}

export interface AiProvider {
  complete(request: AiRequest): Promise<string>;
  stream(request: AiRequest): AsyncIterable<string>;
  structured<T>(request: AiStructuredRequest<T>): Promise<T>;
  decideTools(request: AiToolRequest): Promise<AiToolDecision>;
}

export type AiErrorCode = "not_configured" | "rate_limited" | "unavailable" | "malformed_response";

export class AiError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
}
