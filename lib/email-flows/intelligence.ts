/**
 * Email Automation v2 — the ONE place flow generation talks to a text-AI
 * provider.
 *
 * It reuses Voom's existing MARA text infrastructure (`@/lib/ai`, the same
 * provider the chat, weekly plan, Post Studio and campaign flows use) with
 * strict `json_schema` structured output. No second AI provider is introduced,
 * and nothing in this module can reach Resend, Meta, Seedream/Seedance, the
 * credit ledger or a cron route: it returns validated JSON or a failure reason.
 *
 * A failure is never fatal. The caller keeps the deterministic skeleton, so
 * flow creation cannot become unusable because AI is unavailable.
 */

import "server-only";

import { AiError, createAiProvider } from "@/lib/ai";
import type { AiProvider } from "@/lib/ai";
import {
  FLOW_INTELLIGENCE_SYSTEM_PROMPT,
  flowIntelligenceJsonSchema,
  flowIntelligenceSchema,
  type MaraFlowIntelligence,
} from "./strategy";

/** Injectable for tests: any object with the provider's `structured` call. */
export interface FlowTextAi {
  structured: AiProvider["structured"];
}

export interface FlowIntelligenceDeps {
  /** Test seam. Production uses the existing MARA text provider. */
  ai?: FlowTextAi;
}

export type FlowIntelligenceOutcome =
  | { ok: true; intelligence: MaraFlowIntelligence }
  | { ok: false; reason: "not_configured" | "rate_limited" | "unavailable" | "malformed_response" };

/** A whole email sequence needs more room than a single caption. */
const FLOW_INTELLIGENCE_MAX_TOKENS = 4_000;

/**
 * Asks MARA to fill the supplied skeleton.
 *
 * The provider response is parsed by the zod schema before it is returned — an
 * unusable response becomes `{ ok: false }` and the caller falls back to the
 * deterministic skeleton. This function never throws.
 */
export async function generateFlowIntelligence(
  context: unknown,
  deps: FlowIntelligenceDeps = {},
): Promise<FlowIntelligenceOutcome> {
  try {
    const ai = deps.ai ?? createAiProvider();
    const intelligence = await ai.structured<MaraFlowIntelligence>({
      messages: [
        { role: "system", content: FLOW_INTELLIGENCE_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(context) },
      ],
      temperature: 0.6,
      maxTokens: FLOW_INTELLIGENCE_MAX_TOKENS,
      // Strict structured output where the provider supports it; the zod parse
      // below stays the second safety layer in every case.
      jsonSchema: flowIntelligenceJsonSchema,
      parse: (value) => flowIntelligenceSchema.parse(value),
    });
    return { ok: true, intelligence };
  } catch (error) {
    if (error instanceof AiError) return { ok: false, reason: error.code };
    // A zod rejection (or anything unexpected) is still just "no intelligence":
    // the deterministic skeleton is used and the flow is still created.
    return { ok: false, reason: "malformed_response" };
  }
}
