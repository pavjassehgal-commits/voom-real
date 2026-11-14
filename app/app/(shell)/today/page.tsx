import { TodayDashboard, type TodayChannel, type TodayContentCard } from "@/components/voom/today/TodayDashboard";
import { readSocialChannelReadiness, SOCIAL_CHANNEL_READINESS_ORDER } from "@/lib/social/readiness";
import { PLAN_CHANNEL_LABELS } from "@/lib/voom/workflow/channels";
import { getResendAvailability } from "@/lib/email/config";
import { automationModeConfirmed, normalizeAutomationMode } from "@/lib/voom/automation";
import { normalizePlan } from "@/lib/billing/plans";
import { getOperatingData } from "@/lib/voom/operating-data";
import { buildTodayMetrics } from "@/lib/voom/today-metrics";
import { buildTodayView } from "@/lib/voom/today-view";
import { loadTodayScheduledItems } from "@/lib/voom/today-schedule";
import { createAdminClient } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Today is deliberately a read-only projection over Voom's existing truth:
 * the shared workflow snapshot, its existing todaySummary, the coordinator's
 * existing gap/need evaluation, real stored performance measurements and the
 * real channel connection rows. It creates no parallel coverage, attention,
 * scheduling, performance or connection data.
 */
export default async function TodayPage() {
  const data = await getOperatingData();
  if (!data) return null;

  // The performance report was read once by the shared operating-data read and
  // is shared with the coordinator; awaiting it here fails exactly as this
  // page's own load did if the read is unavailable.
  const [performance, channels, scheduledItems] = await Promise.all([
    data.performance, readChannels(data.user.id),
    loadTodayScheduledItems(createAdminClient(), data.user.id, data.snapshot.today, data.snapshot.timeZone),
  ]);
  const view = buildTodayView(data.snapshot, data.summary, data.coordinator, scheduledItems);
  const displayName = readDisplayName(data.user.email);
  const now = new Date();
  const timeZone = data.snapshot.timeZone;
  const metrics = buildTodayMetrics(performance.items, now, timeZone);

  return <TodayDashboard
    firstName={displayName}
    greeting={greetingFor(now, timeZone)}
    dateLabel={new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "short", year: "numeric" }).format(now).replace(/^(\w+) /, "$1, ")}
    weekNumber={isoWeek(data.snapshot.today)}
    view={view}
    performance={performance}
    metrics={metrics}
    ideas={data.pendingActions.slice(0, 4).map((action) => ({ id: action.id, summary: action.summary }))}
    ideaCount={data.pendingActions.length}
    channels={channels}
    recent={recentContent(data.snapshot.items, performance.items, now)}
    automationMode={normalizeAutomationMode(data.business.automation_level)}
    automationModeConfirmed={automationModeConfirmed(data.business.automation_level)}
    automationPlan={normalizePlan((data.business as { plan?: string | null }).plan)}
  />;
}

/** Real connection state, read exactly as the Channels screen reads it. */
async function readChannels(userId: string): Promise<TodayChannel[]> {
  const readiness = await readSocialChannelReadiness(createAdminClient(), userId);
  const social = SOCIAL_CHANNEL_READINESS_ORDER.map((id): TodayChannel => {
    const entry = readiness.find((row) => row.channel === id);
    return {
      id, name: PLAN_CHANNEL_LABELS[id], href: `/app/${id}`,
      state: !entry ? "unavailable" : entry.connected ? "connected" : "not_connected",
    };
  });
  return [
    ...social,
    { id: "email", name: "Email", href: "/app/connections", state: getResendAvailability().configured ? "ready" : "not_set_up" },
  ];
}

/**
 * Recent content: the workflow items closest to now — the latest that
 * already went out first, then the next upcoming — with measured Instagram
 * results attached only where a stored measurement exists for that draft.
 */
function recentContent(
  items: { draftId: string; concept: string; channel: string; channelLabel: string; contentTypeLabel: string; publishAt: string; localTime: string; dayLabel: string; status: string; statusLabel: string; mediaPreviewUrl: string | null; mediaMimeType: string | null }[],
  measured: { draftId: string | null; metrics: Partial<Record<string, number>> }[],
  now: Date,
): TodayContentCard[] {
  const at = (item: { publishAt: string }) => Date.parse(item.publishAt);
  const past = items.filter((item) => at(item) <= now.getTime()).sort((a, b) => at(b) - at(a));
  const upcoming = items.filter((item) => at(item) > now.getTime()).sort((a, b) => at(a) - at(b));
  return [...past, ...upcoming].slice(0, 4).map((item) => {
    const metrics = measured.find((entry) => entry.draftId === item.draftId)?.metrics ?? null;
    return {
      draftId: item.draftId,
      concept: item.concept,
      channel: item.channel,
      channelLabel: item.channelLabel,
      contentTypeLabel: item.contentTypeLabel,
      when: `${item.dayLabel || ""}${item.dayLabel ? ", " : ""}${item.localTime}`,
      status: item.status,
      statusLabel: item.statusLabel,
      mediaPreviewUrl: item.mediaMimeType?.startsWith("video") ? null : item.mediaPreviewUrl,
      stats: metrics ? { likes: metrics.likes ?? null, comments: metrics.comments ?? null, shares: metrics.shares ?? null } : null,
    };
  });
}

function readDisplayName(email?: string | null) {
  const local = email?.split("@")[0]?.trim();
  const first = local ? local.split(/[._-]/)[0] : "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function greetingFor(now: Date, timeZone: string) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(now));
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** ISO-8601 week number of a local YYYY-MM-DD date. */
function isoWeek(localDate: string) {
  const date = new Date(`${localDate || new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}
