import "server-only";

import type { AdminClient } from "@/lib/post/server-data";
import {
  estimateMediaCostUsd,
  evaluateMediaSpendGate,
  mediaSourceForRun,
  normalizeMediaSpendSettings,
  type MediaSource,
  type MediaSpendBlockReason,
  type MediaSpendSettings,
} from "./media-spend";

/**
 * Server-side, database-backed half of AI Media Spend Control.
 *
 * The policy itself is pure (`lib/mara/media-spend.ts`); this module is the
 * only place that reads the owner's saved settings and the month's estimated
 * spend, so cost logic and gate logic are never duplicated across routes.
 *
 * Accounting reuses the EXISTING `mara_media_generations.estimated_cost_usd`
 * column (migration 0008) — no new spend table. Rows created before the
 * estimate model existed carry NULL and contribute 0; the estimate is written
 * on every new generation row instead.
 *
 * Statuses counted as spend: anything that reached the provider, including a
 * failed attempt (a provider request may still have been billed). `cancelled`
 * and `pending_confirmation` rows were never submitted and are not counted.
 */

export const MEDIA_SPEND_COUNTED_STATUSES = ["queued", "generating", "processing", "completed", "failed"] as const;

export type MediaSpendGateResult =
  | { allow: true; source: MediaSource; reason: null; message: null; estimatedCostUsd: number; budgetReached: boolean }
  | { allow: false; source: MediaSource; reason: MediaSpendBlockReason; message: string; estimatedCostUsd: number; budgetReached: boolean };

export interface MediaSpendGateInput {
  ownerId: string;
  mode: "manual" | "assisted" | "autopilot";
  /** True for a user click ("Create with MARA", "Regenerate", plan item retry). */
  explicit: boolean;
  mediaType: "image" | "video";
  durationSeconds?: number | null;
  now?: Date;
}

/**
 * The owner's saved settings. A missing/absent value (or a database that has
 * not had migration 0031 applied yet) resolves to the shipped defaults, so an
 * unreadable setting can never invent a LOWER budget than the product's
 * documented default.
 */
export async function loadMediaSpendSettings(admin: AdminClient, ownerId: string): Promise<MediaSpendSettings> {
  const { data } = await admin.from("businesses")
    .select("allow_automatic_paid_media,monthly_media_budget_usd")
    .eq("owner_user_id", ownerId)
    .maybeSingle();
  return normalizeMediaSpendSettings(data as Record<string, unknown> | null);
}

/** Estimated media spend for the current UTC month, in USD. */
export async function loadMonthlyMediaSpendUsd(admin: AdminClient, ownerId: string, now: Date = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await admin.from("mara_media_generations")
    .select("estimated_cost_usd")
    .eq("owner_user_id", ownerId)
    .gte("created_at", monthStart)
    .in("status", [...MEDIA_SPEND_COUNTED_STATUSES]);
  // Unreadable accounting never silently authorises a new automatic charge.
  if (error) throw new Error("media_spend_read_failed");
  const spent = (data ?? []).reduce(
    (total: number, row: { estimated_cost_usd?: unknown }) => total + Number(row.estimated_cost_usd ?? 0),
    0,
  );
  return Math.round(spent * 10_000) / 10_000;
}

/**
 * The ONE server-side gate, called immediately before a paid provider
 * submission.
 *
 * An explicit user request is allowed without any read: the owner's own click
 * is the authorisation, and it is recorded as `user_request`.
 *
 * Everything else is automatic and needs the owner's settings plus the month's
 * accounting. A failing accounting read throws instead of returning "allow",
 * so a database problem can never turn into an unaccounted charge — the
 * caller records the failure and the workflow continues without media.
 */
export async function guardMediaSpend(admin: AdminClient, input: MediaSpendGateInput): Promise<MediaSpendGateResult> {
  const source = mediaSourceForRun(input.mode, input.explicit);
  const estimatedCostUsd = estimateMediaCostUsd({ mediaType: input.mediaType, durationSeconds: input.durationSeconds ?? null });

  if (source === "user_request") {
    return evaluateMediaSpendGate({
      mode: input.mode,
      explicit: true,
      allowAutomaticPaidMedia: true,
      monthlyMediaBudgetUsd: Number.POSITIVE_INFINITY,
      spentThisMonthUsd: 0,
      estimatedCostUsd,
      source,
    });
  }

  const now = input.now ?? new Date();
  const [settings, spentThisMonthUsd] = await Promise.all([
    loadMediaSpendSettings(admin, input.ownerId),
    loadMonthlyMediaSpendUsd(admin, input.ownerId, now),
  ]);
  return evaluateMediaSpendGate({
    mode: input.mode,
    explicit: false,
    allowAutomaticPaidMedia: settings.allowAutomaticPaidMedia,
    monthlyMediaBudgetUsd: settings.monthlyMediaBudgetUsd,
    spentThisMonthUsd,
    estimatedCostUsd,
    source,
  });
}
