import "server-only";
import type { AiConfig } from "./config";
import { AiError, type AiJsonSchemaSpec, type AiProvider, type AiRequest, type AiStructuredRequest, type AiToolRequest, type AiToolDecision } from "./types";
import { estimateTextCostUsd } from "./pricing";
import { recordUsageSafely, type UsageRecorder } from "./usage";

type ChatResponse = {
  id?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    cost?: number;
  };
};

/**
 * Structured-output modes, strongest guarantee first: Groq's strict
 * `json_schema` (constrained decoding — output is guaranteed to match the
 * schema), then best-effort `json_schema`, then the legacy `json_object`
 * floor that every chat-completions model accepts.
 */
type StructuredMode = "json_schema_strict" | "json_schema_best_effort" | "json_object";

/** The `response_format` payload sent for one structured attempt. */
type ResponseFormat =
  | { kind: "json_object" }
  | { kind: "json_schema"; name: string; strict: boolean; schema: Record<string, unknown> };

// Bounded retry for strict structured generation: one initial attempt plus at
// most two retries, and ONLY for failures a fresh attempt can plausibly fix
// (network/provider faults, rate limiting, or sampled output the provider
// could not validate against the requested schema). Deterministic schema /
// input failures are never retried, so a bad request can never loop.
export const STRUCTURED_MAX_ATTEMPTS = 3;
const STRUCTURED_RETRY_DELAYS_MS = [250, 500];
export const STRUCTURED_RETRY_MAX_DELAY_MS = 2_000;
/**
 * Unsupported structured-output modes degrade strict -> best-effort ->
 * json_object without spending a retry, so one structured() call can make up
 * to STRUCTURED_MAX_ATTEMPTS + STRUCTURED_FORMAT_FALLBACKS provider requests.
 */
export const STRUCTURED_FORMAT_FALLBACKS = 2;

/**
 * Internal control-flow signal: the provider rejected the structured-output
 * MODE itself (unknown `response_format`/`json_schema`/`strict`) rather than
 * the sampled output. Handled inside `structured()` by degrading to the next
 * mode; the code stays "unavailable" so it never changes caller behavior.
 */
class UnsupportedStructuredModeError extends AiError {
  constructor() {
    super("unavailable", "The AI provider does not support the requested structured output mode.");
    this.name = "UnsupportedStructuredModeError";
  }
}

export class OpenAiCompatibleProvider implements AiProvider {
  private readonly config: AiConfig;
  private readonly usageRecorder?: UsageRecorder;

  constructor(config: AiConfig, usageRecorder?: UsageRecorder) {
    this.config = config;
    this.usageRecorder = usageRecorder;
  }

  async complete(request: AiRequest): Promise<string> {
    const response = await this.request(request, false, null, 1);
    const body = (await safeJson(response)) as ChatResponse;
    await this.recordTextAttempt(request, body, 1, "succeeded", response.status);
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new AiError("malformed_response", "The AI provider returned an empty response.");
    }
    return content.trim();
  }

  async *stream(request: AiRequest): AsyncIterable<string> {
    const response = await this.request(request, true, null, 1);
    if (!response.body) throw new AiError("malformed_response", "The AI provider returned no stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.trim().replace(/^data:\s*/, "");
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          throw new AiError("malformed_response", "The AI provider returned a malformed stream.");
        }
      }
      if (done) break;
    }
    await this.recordTextAttempt(request, {}, 1, "succeeded", response.status);
  }

  async structured<T>(request: AiStructuredRequest<T>): Promise<T> {
    const schema = request.jsonSchema;
    // Requests without an explicit schema keep the historical contract
    // exactly: ONE attempt using response_format {"type":"json_object"} so the
    // chat, planning, reel and video flows are untouched. Requests carrying a
    // schema use json_schema structured output and may retry a transient
    // failure up to STRUCTURED_MAX_ATTEMPTS - 1 times.
    let mode: StructuredMode = !schema ? "json_object" : schema.strict === false ? "json_schema_best_effort" : "json_schema_strict";
    const explicitMaxAttempts = request.maxAttempts === undefined
      ? null
      : Math.min(Math.max(Math.trunc(request.maxAttempts), 1), STRUCTURED_MAX_ATTEMPTS);
    const maxAttempts = schema ? explicitMaxAttempts ?? STRUCTURED_MAX_ATTEMPTS : 1;

    let attempts = 0;
    let providerAttempts = 0;
    let lastError: AiError | null = null;
    while (attempts < maxAttempts) {
      attempts += 1;
      providerAttempts += 1;
      try {
        return await this.structuredOnce(request, mode, providerAttempts);
      } catch (error) {
        if (!(error instanceof AiError)) throw error;
        if (error instanceof UnsupportedStructuredModeError && mode !== "json_object") {
          // The provider does not understand this structured-output mode at
          // all (its model only supports a weaker mode). Degrade
          // strict -> best-effort -> json_object. A capability probe is not a
          // generation failure, so it does not spend a retry.
          // A request-scoped cap counts every provider request, including a
          // capability failure. This lets the live demo enforce exactly one
          // inference while preserving the historical fallback elsewhere.
          if (explicitMaxAttempts !== null && attempts >= maxAttempts) throw error;
          attempts -= 1;
          mode = mode === "json_schema_strict" ? "json_schema_best_effort" : "json_object";
          continue;
        }
        lastError = error;
        if (!error.transient || attempts >= maxAttempts) throw error;
        await sleep(retryDelayMs(attempts, error));
      }
    }
    throw lastError ?? new AiError("malformed_response", "The AI provider returned malformed structured data.");
  }

  /**
   * One structured generation attempt: a single /chat/completions call whose
   * `response_format` is the requested mode, followed by the server-side
   * parsing/validation that remains the second safety layer.
   */
  private async structuredOnce<T>(request: AiStructuredRequest<T>, mode: StructuredMode, attemptNumber: number): Promise<T> {
    const response = await this.request(request, false, responseFormatFor(request.jsonSchema, mode), attemptNumber);
    const body = (await safeJson(response)) as ChatResponse;
    await this.recordTextAttempt(request, body, attemptNumber, "succeeded", response.status);
    const content = body.choices?.[0]?.message?.content;
    // Provider-side failures in a schema-requested call are transient: a fresh
    // sample can succeed. Legacy json_object calls keep transient = false.
    const transient = request.jsonSchema !== undefined;
    if (typeof content !== "string") {
      throw new AiError("malformed_response", "The AI provider returned no structured response.", undefined, transient, "structured_content_missing");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFence(content));
    } catch {
      throw new AiError("malformed_response", "The AI provider returned malformed structured data.", undefined, transient, "structured_json_parse");
    }
    try {
      return request.parse(parsed);
    } catch (error) {
      if (error instanceof AiError) throw error;
      // The local schema rejected what the provider returned. That is a
      // deterministic schema/input failure — never retried — surfaced with the
      // same truthful malformed_response code the callers already translate.
      throw new AiError("malformed_response", "The AI provider returned malformed structured data.", undefined, false, "structured_schema_validation");
    }
  }

  async decideTools(request: AiToolRequest): Promise<AiToolDecision> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}), "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.config.model, messages: request.messages, tools: request.tools, tool_choice: "auto", temperature: 0.2, max_tokens: request.maxTokens ?? 1200, stream: false }),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 30_000), cache: "no-store",
      });
    } catch { throw new AiError("unavailable", "The AI provider is temporarily unavailable."); }
    if (response.status === 429) throw new AiError("rate_limited", "The AI provider is rate limited.", Number(response.headers.get("retry-after")) || undefined);
    if (!response.ok) throw new AiError("unavailable", `The AI provider returned HTTP ${response.status}.`);
    const body = await safeJson(response) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }> };
    const message = body.choices?.[0]?.message;
    if (!message) throw new AiError("malformed_response", "The AI provider returned no tool decision.");
    const toolCalls = (message.tool_calls ?? []).map((call) => ({ id: call.id ?? "", name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}" })).filter((call) => call.id && call.name);
    return { content: typeof message.content === "string" ? message.content : null, toolCalls, assistantMessage: { role: "assistant", content: typeof message.content === "string" ? message.content : null, tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } };
  }

  private async request(request: AiRequest, stream: boolean, json: ResponseFormat | null = null, attemptNumber = 1): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.6,
          max_tokens: request.maxTokens ?? 1200,
          ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
          stream,
          ...(json
            ? json.kind === "json_schema"
              ? { response_format: { type: "json_schema", json_schema: { name: json.name, strict: json.strict, schema: json.schema } } }
              : { response_format: { type: "json_object" } }
            : {}),
        }),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 30_000),
        cache: "no-store",
      });
    } catch {
      await this.recordTextAttempt(request, {}, attemptNumber, "failed", null, "transport");
      throw new AiError("unavailable", "The AI provider is temporarily unavailable.", undefined, true, "transport");
    }

    if (response.status === 429) {
      await this.recordTextAttempt(request, {}, attemptNumber, "failed", response.status, "rate_limited");
      const retryAfter = Number(response.headers.get("retry-after")) || undefined;
      throw new AiError("rate_limited", "The AI provider is rate limited.", retryAfter, true);
    }
    if (!response.ok) {
      if (json && response.status === 400) {
        const body = await safeJson(response) as { error?: { message?: string; code?: string; failed_generation?: unknown } };
        const detail = `${body.error?.code ?? ""} ${body.error?.message ?? ""}`;
        if (json.kind !== "json_object" && /response_format|json_schema|structured output|not supported|unsupported|unknown (field|parameter|value)/i.test(detail)) {
          await this.recordTextAttempt(request, body as ChatResponse, attemptNumber, "failed", response.status, "unsupported_structured_mode");
          // The provider rejected the structured-output MODE itself, not the
          // sampled output — degrade the mode instead of burning retries.
          throw new UnsupportedStructuredModeError();
        }
        if (/json|failed_generation|validate/i.test(detail) || typeof body.error?.failed_generation === "string") {
          await this.recordTextAttempt(request, body as ChatResponse, attemptNumber, "failed", response.status, "provider_validation");
          // The provider sampled output it could not validate against the
          // request (Groq json_validate_failed / failed_generation, or the
          // documented "does not match the expected schema" failure). A fresh
          // attempt can succeed: transient. The provider's raw
          // failed_generation payload is deliberately NOT echoed anywhere.
          throw new AiError("malformed_response", "The AI provider returned malformed structured data.", undefined, true);
        }
      }
      if (response.status >= 500) {
        await this.recordTextAttempt(request, {}, attemptNumber, "failed", response.status, "provider_unavailable");
        throw new AiError("unavailable", `The AI provider returned HTTP ${response.status}.`, undefined, true);
      }
      // Every other 4xx is a deterministic request/input failure (bad model,
      // bad schema, auth) — retried never, surfaced truthfully.
      await this.recordTextAttempt(request, {}, attemptNumber, "failed", response.status, "provider_http");
      throw new AiError("unavailable", `The AI provider returned HTTP ${response.status}.`, undefined, false, "provider_http");
    }
    return response;
  }

  private async recordTextAttempt(
    request: AiRequest,
    body: ChatResponse,
    attemptNumber: number,
    status: "succeeded" | "failed",
    httpStatus: number | null,
    errorCode: string | null = null,
  ): Promise<void> {
    if (!request.usage) return;
    const inputTokens = finiteCount(body.usage?.prompt_tokens);
    const outputTokens = finiteCount(body.usage?.completion_tokens);
    const reasoningTokens = finiteCount(body.usage?.completion_tokens_details?.reasoning_tokens);
    const totalTokens = finiteCount(body.usage?.total_tokens);
    const estimate = estimateTextCostUsd({ provider: this.config.provider, model: this.config.model, inputTokens, outputTokens, reasoningTokens });
    await recordUsageSafely(this.usageRecorder, {
      context: request.usage,
      attemptNumber,
      provider: this.config.provider,
      model: this.config.model,
      status,
      providerRequestId: typeof body.id === "string" ? body.id : null,
      httpStatus,
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      estimatedCostUsd: estimate.costUsd,
      observedCostUsd: finiteMoney(body.usage?.cost),
      confirmedProviderChargeUsd: null,
      pricingVersion: estimate.pricingVersion,
      errorCode,
    });
  }
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteMoney(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function responseFormatFor(schema: AiJsonSchemaSpec | undefined, mode: StructuredMode): ResponseFormat {
  if (schema && mode !== "json_object") {
    return { kind: "json_schema", name: schema.name, strict: mode === "json_schema_strict", schema: schema.schema };
  }
  return { kind: "json_object" };
}

function retryDelayMs(attempt: number, error: AiError): number {
  const hinted = error.code === "rate_limited" && error.retryAfterSeconds ? error.retryAfterSeconds * 1_000 : 0;
  const base = STRUCTURED_RETRY_DELAYS_MS[Math.min(attempt - 1, STRUCTURED_RETRY_DELAYS_MS.length - 1)];
  return Math.min(Math.max(base, hinted), STRUCTURED_RETRY_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AiError("malformed_response", "The AI provider returned invalid JSON.", undefined, false, "response_json");
  }
}

function stripJsonFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}
