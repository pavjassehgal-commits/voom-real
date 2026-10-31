import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/utils/supabase/admin";

export type AiUsageCategory = "text" | "caption" | "recommendation" | "planning" | "image" | "video";

export interface AiUsageContext {
  ownerId: string;
  businessId?: string | null;
  operationKey: string;
  operationType: string;
  category: AiUsageCategory;
}

export interface ProviderUsageAttempt {
  context: AiUsageContext;
  attemptNumber: number;
  provider: string;
  model: string;
  status: "succeeded" | "failed" | "unknown";
  providerRequestId?: string | null;
  httpStatus?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  mediaUnits?: number | null;
  durationSeconds?: number | null;
  estimatedCostUsd?: number | null;
  observedCostUsd?: number | null;
  confirmedProviderChargeUsd?: number | null;
  pricingVersion?: string | null;
  errorCode?: string | null;
}

export type UsageRecorder = (attempt: ProviderUsageAttempt) => Promise<void>;

export function createUsageRecorder(admin?: SupabaseClient): UsageRecorder {
  return async (attempt) => {
    const db = admin ?? createAdminClient();
    const { error } = await db.rpc("record_ai_usage_attempt", {
      p_owner_user_id: attempt.context.ownerId,
      p_business_id: attempt.context.businessId ?? null,
      p_operation_key: attempt.context.operationKey.slice(0, 160),
      p_operation_type: attempt.context.operationType.slice(0, 80),
      p_category: attempt.context.category,
      p_provider: attempt.provider.slice(0, 80),
      p_model: attempt.model.slice(0, 160),
      p_attempt_number: attempt.attemptNumber,
      p_status: attempt.status,
      p_provider_request_id: attempt.providerRequestId ?? null,
      p_http_status: attempt.httpStatus ?? null,
      p_input_tokens: attempt.inputTokens ?? null,
      p_output_tokens: attempt.outputTokens ?? null,
      p_reasoning_tokens: attempt.reasoningTokens ?? null,
      p_total_tokens: attempt.totalTokens ?? null,
      p_media_units: attempt.mediaUnits ?? null,
      p_duration_seconds: attempt.durationSeconds ?? null,
      p_estimated_cost_usd: attempt.estimatedCostUsd ?? null,
      p_observed_cost_usd: attempt.observedCostUsd ?? null,
      p_confirmed_provider_charge_usd: attempt.confirmedProviderChargeUsd ?? null,
      p_pricing_version: attempt.pricingVersion ?? null,
      p_error_code: attempt.errorCode ?? null,
    });
    if (error) throw new Error(`ai_usage_record_failed:${error.code ?? "unknown"}`);
  };
}

export async function recordUsageSafely(recorder: UsageRecorder | undefined, attempt: ProviderUsageAttempt): Promise<void> {
  if (!recorder) return;
  try {
    await recorder(attempt);
  } catch (error) {
    console.error("[ai-usage] durable recording failed", {
      operationType: attempt.context.operationType,
      attemptNumber: attempt.attemptNumber,
      code: error instanceof Error ? error.message.split(":")[0] : "unknown",
    });
  }
}
