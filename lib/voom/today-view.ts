import { addDays, formatLocalDate } from "./timezone.ts";

export type TodayItem = {
  draftId: string;
  slotDate: string;
  localDate: string;
  status: string;
  channelLabel: string;
  contentTypeLabel: string;
  concept: string;
  localTime: string;
  dayLabel?: string;
  statusLabel?: string;
  mediaPreviewUrl?: string | null;
};

export type TodaySnapshotInput<T extends TodayItem = TodayItem> = {
  today: string;
  planValidUntil: string | null;
  items: T[];
};

export type TodaySummaryInput<T extends TodayItem = TodayItem> = {
  needsApproval: T[];
  waitingForMedia: T[];
  failed: T[];
  missed: T[];
  next: T | null;
};

export type TodayCoordinatorInput = {
  gaps: { date: string }[];
  needs: { type: string; title: string; description: string }[];
  state?: {
    commitments: {
      id: string;
      sourceId: string;
      channel: string;
      title: string;
      localDate: string;
      localTime: string;
      status: string;
    }[];
  };
} | null;

export type TodayCoverageDay = {
  date: string;
  label: string;
  dayNumber: string;
  items: TodayItem[];
  covered: boolean;
};

/**
 * Presentation-only projection over the existing workflow/coordinator truth.
 * It never creates a second definition of a commitment or mutates workflow
 * state: a covered day is simply a day with a real shared-snapshot item.
 */
export function buildTodayView<T extends TodayItem>(
  snapshot: TodaySnapshotInput<T>,
  summary: TodaySummaryInput<T>,
  coordinator: TodayCoordinatorInput,
) {
  const snapshotIds = new Set(snapshot.items.map((item) => item.draftId));
  const commitmentItems: TodayItem[] = (coordinator?.state?.commitments ?? [])
    .filter((commitment) => commitment.channel !== "email" && !snapshotIds.has(commitment.sourceId))
    .map((commitment) => ({
      draftId: commitment.sourceId || commitment.id,
      slotDate: commitment.localDate,
      localDate: commitment.localDate,
      status: commitment.status,
      channelLabel: channelLabel(commitment.channel),
      contentTypeLabel: formatLabel(commitment.channel),
      concept: commitment.title,
      localTime: commitment.localTime,
      dayLabel: commitment.localDate === snapshot.today ? "Today" : undefined,
      statusLabel: statusLabel(commitment.status),
      mediaPreviewUrl: null,
    }));
  const allCommitments: TodayItem[] = [...snapshot.items, ...commitmentItems];
  const days: TodayCoverageDay[] = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(snapshot.today, index);
    const items = allCommitments.filter((item) => item.slotDate === date || item.localDate === date);
    return {
      date,
      label: new Intl.DateTimeFormat("en-AE", { timeZone: "UTC", weekday: "narrow" }).format(new Date(`${date}T12:00:00Z`)),
      dayNumber: String(Number(date.slice(-2))),
      items,
      covered: items.length > 0,
    };
  });

  const openGaps = coordinator?.gaps.length ?? null;
  const coverageEnd = snapshot.planValidUntil ?? days.at(-1)?.date ?? snapshot.today;
  const coverage = allCommitments.length > 0 && openGaps === 0
    ? { state: "covered" as const, title: `Your marketing is covered through ${shortDate(coverageEnd)}.`, detail: "Your rolling plan has no uncovered social slots." }
    : openGaps !== null && openGaps > 0
      ? { state: "gaps" as const, title: `${openGaps} marketing slot${openGaps === 1 ? " needs" : "s need"} coverage.`, detail: "Open Marketing Plan to review the uncovered dates." }
      : allCommitments.length > 0
        ? { state: "active" as const, title: "Your marketing plan is in motion.", detail: `Voom is tracking commitments through ${shortDate(coverageEnd)}.` }
        : { state: "empty" as const, title: "Your marketing plan is ready when you are.", detail: "Choose your channels and build the next seven days." };

  const attention = summary.missed.length
    ? { state: "action" as const, title: "A scheduled time was missed", detail: `${summary.missed.length} item${summary.missed.length === 1 ? " needs" : "s need"} to be posted now or rescheduled.`, href: "/app/calendar" }
    : summary.failed.length
      ? { state: "action" as const, title: "Something needs attention", detail: `${summary.failed.length} item${summary.failed.length === 1 ? " stopped" : "s stopped"} safely and can be reviewed.`, href: "/app/calendar" }
      : summary.waitingForMedia.length
        ? { state: "action" as const, title: "Media is not ready", detail: `${summary.waitingForMedia.length} scheduled item${summary.waitingForMedia.length === 1 ? " is" : "s are"} safely held until its visual is ready.`, href: "/app/calendar" }
        : summary.needsApproval.length
          ? { state: "action" as const, title: `${summary.needsApproval.length} item${summary.needsApproval.length === 1 ? " needs" : "s need"} your approval`, detail: "Review the prepared content before Voom schedules it.", href: "/app/approvals" }
          : { state: "clear" as const, title: "You’re all caught up.", detail: "Nothing needs your attention right now.", href: "/app/plan" };

  const coordinatorInsight = coordinator?.needs.find((need) => !["nothing_needed", "pending_approval", "content_calendar_gap"].includes(need.type)) ?? null;

  const coordinatorNext = commitmentItems
    .filter((item) => item.localDate >= snapshot.today && ["scheduled", "publishing"].includes(item.status))
    .sort((a, b) => `${a.localDate} ${a.localTime}`.localeCompare(`${b.localDate} ${b.localTime}`))[0] ?? null;

  return { days, coverage, attention, next: summary.next ?? coordinatorNext, coordinatorInsight };
}

function shortDate(date: string) {
  return formatLocalDate(date).replace(/\s+\d{4}$/, "");
}

function channelLabel(channel: string) {
  if (channel.startsWith("instagram_")) return "Instagram";
  if (channel.startsWith("tiktok_")) return "TikTok";
  if (channel.startsWith("youtube_")) return "YouTube";
  return "Social";
}

function formatLabel(channel: string) {
  if (channel === "instagram_post") return "Post";
  if (channel === "instagram_reel") return "Reel";
  if (channel === "instagram_story") return "Story";
  if (channel === "youtube_short") return "Short";
  return "Video";
}

function statusLabel(status: string) {
  return status.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
