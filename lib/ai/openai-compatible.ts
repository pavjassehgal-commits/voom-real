import "server-only";
import type { AiConfig } from "./config";
import { AiError, type AiProvider, type AiRequest, type AiStructuredRequest, type AiToolRequest, type AiToolDecision } from "./types";

type ChatResponse = { choices?: Array<{ message?: { content?: string } }> };

export class OpenAiCompatibleProvider implements AiProvider {
  constructor(private readonly config: AiConfig) {}

  async complete(request: AiRequest): Promise<string> {
    const response = await this.request(request, false);
    const body = (await safeJson(response)) as ChatResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new AiError("malformed_response", "The AI provider returned an empty response.");
    }
    return content.trim();
  }

  async *stream(request: AiRequest): AsyncIterable<string> {
    const response = await this.request(request, true);
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
  }

  async structured<T>(request: AiStructuredRequest<T>): Promise<T> {
    const response = await this.request(request, false, true);
    const body = (await safeJson(response)) as ChatResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new AiError("malformed_response", "The AI provider returned no structured response.");
    }
    try {
      return request.parse(JSON.parse(stripJsonFence(content)));
    } catch (error) {
      if (error instanceof AiError) throw error;
      throw new AiError("malformed_response", "The AI provider returned malformed structured data.");
    }
  }

  async decideTools(request: AiToolRequest): Promise<AiToolDecision> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}), "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.config.model, messages: request.messages, tools: request.tools, tool_choice: "auto", temperature: 0.2, max_tokens: request.maxTokens ?? 1200, stream: false }),
        signal: AbortSignal.timeout(30_000), cache: "no-store",
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

  private async request(request: AiRequest, stream: boolean, json = false): Promise<Response> {
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
          stream,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
        cache: "no-store",
      });
    } catch {
      throw new AiError("unavailable", "The AI provider is temporarily unavailable.");
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after")) || undefined;
      throw new AiError("rate_limited", "The AI provider is rate limited.", retryAfter);
    }
    if (!response.ok) {
      throw new AiError("unavailable", `The AI provider returned HTTP ${response.status}.`);
    }
    return response;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AiError("malformed_response", "The AI provider returned invalid JSON.");
  }
}

function stripJsonFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}
