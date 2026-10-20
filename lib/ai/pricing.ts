export const AI_PRICING_VERSION = "2026-10-19.v1";

export interface ModelPricing {
  provider: string;
  model: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  reasoningUsdPerMillionTokens?: number;
}

// Conservative reference data only. Unknown models deliberately produce no estimate.
export const MODEL_PRICING: readonly ModelPricing[] = [
  { provider: "openai", model: "gpt-4o-mini", inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 },
  { provider: "openrouter", model: "openai/gpt-oss-20b", inputUsdPerMillionTokens: 0.03, outputUsdPerMillionTokens: 0.14 },
] as const;

export function estimateTextCostUsd(input: {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  pricing?: readonly ModelPricing[];
}): { costUsd: number | null; pricingVersion: string | null } {
  const row = (input.pricing ?? MODEL_PRICING).find((candidate) =>
    candidate.provider.toLowerCase() === input.provider.toLowerCase() && candidate.model === input.model,
  );
  if (!row || input.inputTokens === null || input.outputTokens === null) return { costUsd: null, pricingVersion: null };
  const reasoningRate = row.reasoningUsdPerMillionTokens ?? row.outputUsdPerMillionTokens;
  const outputWithoutReasoning = Math.max(0, input.outputTokens - (input.reasoningTokens ?? 0));
  const cost = (input.inputTokens * row.inputUsdPerMillionTokens
    + outputWithoutReasoning * row.outputUsdPerMillionTokens
    + (input.reasoningTokens ?? 0) * reasoningRate) / 1_000_000;
  return { costUsd: Math.round(cost * 100_000_000) / 100_000_000, pricingVersion: AI_PRICING_VERSION };
}
