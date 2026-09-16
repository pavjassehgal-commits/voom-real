/**
 * MARA Campaign Intelligence — the ONE place campaign generation talks to a
 * text-AI provider.
 *
 * It reuses Voom's existing MARA text infrastructure (`@/lib/ai`, the same
 * provider the chat, weekly-plan and Post Studio flows use) with strict
 * `json_schema` structured output. No second AI provider is introduced, and
 * nothing in this module can reach Resend, Meta, Seedream/Seedance, the credit
 * ledger or a cron route: it returns validated JSON or a failure reason.
 *
 * A failure is never fatal. The caller keeps the deterministic v1 plan, so
 * campaign creation cannot become less reliable because v2 added intelligence.
 */

import "server-only";

import { AiError, createAiProvider } from "@/lib/ai";
import type { AiProvider } from "@/lib/ai";
import {
  CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT,
  campaignIntelligenceJsonSchema,
  campaignIntelligenceSchema,
  type MaraCampaignIntelligence,
} from "./strategy";

/** Injectable for tests: any object with the provider's `structured` call. */
export interface CampaignTextAi {
  structured: AiProvider["structured"];
}

export interface CampaignIntelligenceDeps {
  /** Test seam. Production uses the existing MARA text provider. */
  ai?: CampaignTextAi;
}

export type CampaignIntelligenceOutcome =
  | { ok: true; intelligence: MaraCampaignIntelligence }
  | { ok: false; reason: "not_configured" | "rate_limited" | "unavailable" | "malformed_response" };

/** Campaign copy is longer than a single post caption, so it gets more room. */
const CAMPAIGN_INTELLIGENCE_MAX_TOKENS = 4_000;

/**
 * Asks MARA to fill the supplied skeleton.
 *
 * The provider response is parsed by the zod schema before it is returned —
 * an unusable response becomes `{ ok: false }` and the caller falls back to
 * the deterministic plan. This function never throws.
 */
export async function generateCampaignIntelligence(
  context: unknown,
  deps: CampaignIntelligenceDeps = {},
): Promise<CampaignIntelligenceOutcome> {
  try {
    const ai = deps.ai ?? createAiProvider();
    const intelligence = await ai.structured<MaraCampaignIntelligence>({
      messages: [
        { role: "system", content: CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(context) },
      ],
      temperature: 0.6,
      maxTokens: CAMPAIGN_INTELLIGENCE_MAX_TOKENS,
      // Strict structured output where the provider supports it; the zod
      // parse below stays the second safety layer in every case.
      jsonSchema: campaignIntelligenceJsonSchema,
      parse: (value) => campaignIntelligenceSchema.parse(value),
    });
    return { ok: true, intelligence };
  } catch (error) {
    if (error instanceof AiError) {
      return { ok: false, reason: error.code };
    }
    // A zod rejection (or anything unexpected) is still just "no intelligence":
    // the deterministic v1 plan is used and the campaign is still created.
    return { ok: false, reason: "malformed_response" };
  }
}
