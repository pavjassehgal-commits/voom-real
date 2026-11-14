import type { SocialCalendarItemView } from "@/lib/social/server-drafts";
import type { ScheduledPost } from "./today-schedule";
import type { WorkflowView } from "./workflow/read";
import { requiresApproval } from "./workflow/state";

export type CalendarEvent =
  | { type: "workflow"; item: WorkflowView; scheduled?: boolean }
  | { type: "social"; item: SocialCalendarItemView; scheduled?: boolean }
  | { type: "scheduled"; item: ScheduledPost };

/** Join by draft before grouping by local date. A job's execution time wins over a proposed time. */
export function calendarByDate(items: WorkflowView[], social: SocialCalendarItemView[], scheduled: ScheduledPost[], filter: string) {
  const events = new Map<string, CalendarEvent>();
  for (const item of social) events.set(item.draftId, { type: "social", item });
  for (const item of items) events.set(item.draftId, { type: "workflow", item });
  for (const job of scheduled) {
    const existing = events.get(job.draftId);
    const time = { localDate: job.localDate, localTime: job.localTime, dayLabel: job.dayLabel };
    if (existing?.type === "workflow" && existing.item.status === "scheduled") {
      events.set(job.draftId, { ...existing, scheduled: true, item: { ...existing.item, ...time, publishAt: job.publishAt } });
    } else if (existing?.type === "social" && existing.item.queueStatus === "scheduled") {
      events.set(job.draftId, { ...existing, scheduled: true, item: { ...existing.item, ...time, scheduledAt: job.publishAt } });
    } else if (!existing) {
      events.set(job.draftId, { type: "scheduled", item: job });
    }
  }
  const dates = new Map<string, CalendarEvent[]>();
  for (const event of events.values()) {
    if (filter !== "All" && event.item.contentTypeLabel !== filter) continue;
    const day = dates.get(event.item.localDate) ?? [];
    day.push(event);
    dates.set(event.item.localDate, day);
  }
  const instant = (event: CalendarEvent) => Date.parse(event.type === "social" ? event.item.scheduledAt : event.item.publishAt);
  for (const day of dates.values()) day.sort((a, b) => instant(a) - instant(b));
  return dates;
}

export function calendarNeedsApproval(event: CalendarEvent) {
  return event.type === "workflow" && requiresApproval(event.item.status);
}

export function calendarSummary(events: CalendarEvent[]) {
  return {
    total: events.length,
    scheduled: events.filter((event) => event.type === "scheduled" || event.scheduled).length,
    approval: events.filter(calendarNeedsApproval).length,
  };
}
