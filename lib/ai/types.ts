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

/**
 * A provider-side structured output contract, sent as Groq's
 * `response_format: { type: "json_schema", json_schema: ... }`.
 *
 * `strict` (default true) asks for constrained decoding, which requires the
 * schema to be a closed object (`additionalProperties: false`) with every
 * property listed in `required`; optional values are expressed as
 * `["type", "null"]` unions, never as omitted keys.
 */
export interface AiJsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface AiStructuredRequest<T> extends AiRequest {
  parse: (value: unknown) => T;
  /**
   * The provider-side schema for this structured call. When set, the request
   * uses `json_schema` structured output (strict unless marked otherwise)
   * with a small bounded retry for transient generation/provider failures.
   * When omitted, the call keeps the legacy `json_object` contract exactly:
   * a single attempt, no retry.
   */
  jsonSchema?: AiJsonSchemaSpec;
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
  public readonly code: AiErrorCode;
  public readonly retryAfterSeconds?: number;
  /**
   * True when a fresh attempt with unchanged input can plausibly succeed
   * (network/provider faults, rate limits, sampled structured output the
   * provider could not validate). False for deterministic schema/input
   * failures, which must never be retried.
   */
  public readonly transient: boolean;

  constructor(code: AiErrorCode, message: string, retryAfterSeconds?: number, transient: boolean = false) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.transient = transient;
  }
}
