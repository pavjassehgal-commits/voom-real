import { MaraOverview } from "@/components/voom/mara/MaraOverview";
import { getCreditSummary } from "@/lib/billing/ledger";
import { normalizePlan } from "@/lib/billing/plans";
import { normalizeMediaSpendSettings } from "@/lib/mara/media-spend";
import { readSocialChannelReadiness } from "@/lib/social/readiness";
import { normalizeAutomationMode } from "@/lib/voom/automation";
import { getOperatingData } from "@/lib/voom/operating-data";
import { accountTimezone, addDays } from "@/lib/voom/timezone";
import { createAdminClient } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const NEED_HIDDEN = new Set(["nothing_needed", "pending_approval", "content_calendar_gap"]);

/**
 * MARA · AI marketing manager (Figma "19 — MARA", Keep).
 *
 * A read-only overview of what MARA is doing for this account, from the same
 * operating data every screen reads: the approval feed, the shared workflow
 * snapshot, the coordinator's gaps and needs, real connection rows, the
 * credit ledger and the saved brand profile. The reference's chat panel and
 * "Ask MARA" button are not shown — the MARA chat API is retired — and its
 * engagement-uplift, time-saved and ad-spend figures are not shown because
 * Voom does not measure them.
 */
export default async function MaraPage() {
  const data = await getOperatingData();
  if (!data) return null;
  const admin = createAdminClient();
  const planId = normalizePlan((data.business as { plan?: string | null }).plan);
  const mode = normalizeAutomationMode(data.business.automation_level);
  const timeZone = accountTimezone((data.business as { timezone?: string | null }).timezone);
  const [credits, readiness] = await Promise.all([
    getCreditSummary(admin, data.user.id, planId).catch(() => null),
    readSocialChannelReadiness(admin, data.user.id).catch(() => []),
  ]);
  const spend = normalizeMediaSpendSettings(data.business as { allow_automatic_paid_media?: unknown; monthly_media_budget_usd?: unknown });
  const items = data.snapshot.items;
  const pending = data.actions.filter((action) => action.status === "pending");
  const mediaActive = items.filter((item) => item.status === "generating" || item.status === "waiting_for_media");
  const gaps = data.coordinator?.gaps ?? [];
  const disconnected = readiness.filter((entry) => !entry.connected && data.snapshot.selectedChannels.includes(entry.channel));
  const insights = (data.coordinator?.needs ?? []).filter((need) => !NEED_HIDDEN.has(need.type)).slice(0, 2);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(data.snapshot.today, index);
    return { date, items: items.filter((item) => (item.localDate || item.slotDate) === date), gap: gaps.some((gap) => gap.date === date) };
  });
  const business = data.business;
  const knows: [string, string][] = [
    ["Brand", business.brand_name ?? ""],
    ["Audience", (business.target_customer ?? []).join(", ")],
    ["Voice", (business.brand_personality ?? []).join(", ")],
    ["Goal", business.main_goal ?? ""],
    ["Channels", (business.preferred_channels ?? []).join(", ")],
  ];
  return <MaraOverview
    mode={mode}
    planId={planId}
    timeZone={timeZone}
    plannedCount={items.length}
    pending={pending.map((action) => ({ id: action.id, summary: action.summary, reason: typeof action.new_value?.reason === "string" ? action.new_value.reason : null }))}
    mediaActiveCount={mediaActive.length}
    credits={credits ? { remaining: credits.remaining, total: credits.allowance + credits.additional } : null}
    gapDates={gaps.map((gap) => gap.date)}
    disconnected={disconnected.map((entry) => entry.channel)}
    insights={insights.map((need) => ({ title: need.title, description: need.description }))}
    days={days.map((day) => ({ date: day.date, gap: day.gap, items: day.items.map((item) => ({ draftId: item.draftId, channel: item.channel, concept: item.concept })) }))}
    knows={knows}
    allowAutomaticPaidMedia={spend.allowAutomaticPaidMedia}
    monthlyMediaBudgetUsd={spend.monthlyMediaBudgetUsd}
    activity={data.actions.slice(0, 6).map((action) => ({ id: action.id, summary: action.summary, status: action.status, note: action.status === "pending" ? "Waiting for you" : action.result_summary ?? action.error_summary ?? action.status, createdAt: action.created_at }))}
  />;
}
