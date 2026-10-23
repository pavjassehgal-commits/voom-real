"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { CreateContentModal } from "@/components/voom/modals/CreateContentModal";
import { SavedCalendarDetailModal } from "@/components/voom/modals/SavedCalendarDetailModal";
import { SocialEditorModal } from "@/components/voom/modals/SocialEditorModal";
import { Btn, Tag } from "@/components/voom/ui/primitives";
import { BTN, ChannelGlyph, StatusChip } from "@/components/voom/redesign/ui";
import { cx } from "@/lib/voom/cx";
import { currentScheduleDate } from "@/lib/voom/schedule-guard";
import { PublishingQueue } from "@/components/voom/PublishingQueue";
import type { WorkflowSnapshot, WorkflowView } from "@/lib/voom/workflow/read";
import { MEDIA_GENERATION_HARD_TIMEOUT_MINUTES, WORKFLOW_STATUSES } from "@/lib/voom/workflow/state";
import { isPastInstant } from "@/lib/voom/schedule-guard";
import type { SocialCalendarItemView } from "@/lib/social/server-drafts";
import { ChannelPill, StatePill } from "@/components/voom/workspace/ui";
import {
  CHANNEL_ACCENT_HEX,
  channelIdentity,
  providerConfirmationLabel,
  socialQueueTone,
  TONE_ACCENT_HEX,
  workflowTone,
  type ChannelKey,
  type WorkspaceTone,
} from "@/lib/voom/workflow/presentation";

/**
 * The Content Calendar is the authoritative visual schedule of the ONE
 * executable content workflow, across every channel. Instagram cells are real
 * workflow items with their real local scheduled time and authoritative
 * status. TikTok and YouTube items use their native channel/format and
 * durable queue-derived labels; only provider confirmation can say Published.
 * Clicking a cell opens the real draft. There is no sample dataset or
 * hardcoded month.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const FILTERS = ["All", "Instagram Post", "Reel", "Instagram Story", "TikTok Video", "YouTube Short", "YouTube Video"] as const;
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One calendar cell entry: an active Marketing Plan item or a standalone
 * approved TikTok/YouTube draft. Both surfaces use truthful queue status. */
type CalendarEvent =
  | { type: "workflow"; item: WorkflowView }
  | { type: "social"; item: SocialCalendarItemView };

function timeOf(event: CalendarEvent): string {
  return event.item.localTime;
}

/** One truthful tooltip per cell — source, status, provider note, asset. */
function eventTitle(event: CalendarEvent): string {
  if (event.type === "social") {
    return [
      event.item.sourceLabel,
      event.item.statusLabel,
      event.item.queueFailureMessage,
      event.item.media ? `${event.item.media.displayName} · ${event.item.media.mimeType}` : "No video file attached",
    ].filter(Boolean).join(" · ");
  }
  return [
    event.item.sourceLabel,
    event.item.statusLabel,
    event.item.failureMessage,
    event.item.mediaDisplayName && event.item.mediaMimeType ? `${event.item.mediaDisplayName} · ${event.item.mediaMimeType}` : null,
  ].filter(Boolean).join(" · ");
}

function channelOf(event: CalendarEvent): string {
  return event.type === "workflow" ? event.item.channel : event.item.channel;
}

/** Truthful provider confirmation for one cell — null unless Voom can prove it. */
function confirmedOf(event: CalendarEvent): string | null {
  if (event.type === "workflow") {
    return providerConfirmationLabel(event.item.channel, {
      instagramMediaId: event.item.instagramMediaId,
      queueStatus: event.item.queueStatus,
    });
  }
  return providerConfirmationLabel(event.item.channel, { queueStatus: event.item.queueStatus });
}

/** The per-item reason Voom surfaces this cell as needing attention. */
function attentionReason(item: WorkflowView): string | null {
  if (item.status === "missed") return item.missedReason ?? "Its scheduled time passed without publishing.";
  if (item.status === "failed") return item.failureMessage ?? (item.failedStage === "media" ? "Media generation stopped safely. Nothing was published." : "Publishing stopped safely. Nothing was published twice.");
  if (item.status === "media_delayed") return "Media generation is delayed, so this schedule is held — Voom will not publish until a real visual exists.";
  if (item.status === "media_timed_out") return `That generation ran past Voom's ${MEDIA_GENERATION_HARD_TIMEOUT_MINUTES}-minute limit, so the schedule stays held — nothing was published and nothing new was charged.`;
  if ((item.status === "scheduled" || item.status === "publishing") && isPastInstant(item.publishAt)) {
    return "This item is past its scheduled time. It stays right here until Voom completes it — it is never silently dropped or published twice.";
  }
  return null;
}

type CalendarMode = "month" | "week";

export default function CalendarPage() {
  const { open } = useModal();
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null);
  const [socialItems, setSocialItems] = useState<SocialCalendarItemView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("All");
  const [cursor, setCursor] = useState<{ month: number; year: number } | null>(null);
  const [mode, setMode] = useState<CalendarMode>("month");
  // The week view is anchored on one real local date; the selected day starts as that date.
  const [weekDay, setWeekDay] = useState<string | null>(null);
  const [showAllPending, setShowAllPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/voom/workflow", { cache: "no-store" });
      const body = await response.json() as { snapshot?: WorkflowSnapshot; socialItems?: SocialCalendarItemView[]; error?: string };
      if (!response.ok || !body.snapshot) throw new Error(body.error ?? "Your schedule couldn't load.");
      setSnapshot(body.snapshot);
      setSocialItems(body.socialItems ?? []);
      setError(null);
      // The calendar always opens on the real current local month.
      setCursor((current) => current ?? monthOf(body.snapshot!.today));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your schedule couldn't load.");
    }
  }, []);

  // Deferred one tick so the initial fetch is a subscription to an external
  // system rather than a synchronous cascading render.
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("voom:data-changed", refresh);
    return () => window.removeEventListener("voom:data-changed", refresh);
  }, [load]);

  const items = useMemo(
    () => (snapshot?.items ?? []).filter((item) => filter === "All" || item.contentTypeLabel === filter),
    [snapshot, filter],
  );
  // The shared workflow snapshot includes native channel/format identities for
  // Marketing Plan items. Keep the extra Studio feed for approved standalone
  // drafts only, so planned TikTok/YouTube items never render twice.
  const socialCells = useMemo(() => {
    const planDraftIds = new Set(snapshot?.planDraftIds ?? []);
    return socialItems.filter((item) =>
      !planDraftIds.has(item.draftId)
        && (filter === "All" || item.contentTypeLabel === filter),
    );
  }, [socialItems, snapshot, filter]);
  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const item of items) map.set(item.localDate, [...(map.get(item.localDate) ?? []), { type: "workflow", item }]);
    for (const item of socialCells) map.set(item.localDate, [...(map.get(item.localDate) ?? []), { type: "social", item }]);
    for (const list of map.values()) list.sort((a, b) => (timeOf(a) === timeOf(b) ? 0 : timeOf(a) < timeOf(b) ? -1 : 1));
    return map;
  }, [items, socialCells]);

  // Fallback before the first snapshot arrives: the real current local date,
  // not a hardcoded month and not the device's UTC date.
  const view = cursor ?? monthOf(currentScheduleDate());
  const cells = useMemo(() => buildCells(view.year, view.month), [view.year, view.month]);
  const counts = useMemo(() => countByStatus(items), [items]);
  const totalVisible = items.length + socialCells.length;
  const scheduledCount = (counts.scheduled ?? 0) + (counts.publishing ?? 0) + socialCells.filter((item) => socialQueueTone(item.queueStatus) === "blue").length;
  const approvalCount = (counts.needs_approval ?? 0) + (counts.ready_for_review ?? 0);
  const draftCount = (counts.planned ?? 0) + (counts.needs_content ?? 0) + (counts.generating ?? 0) + (counts.waiting_for_media ?? 0);

  // "What needs attention" is a truthful projection of the real workflow state —
  // never a separate calculation: it lists the exact items the read model marks
  // as missed, failed, delayed, timed out, or scheduled past their own time.
  const attention = useMemo(
    () => items
      .map((item) => ({ item, reason: attentionReason(item) }))
      .filter((entry): entry is { item: WorkflowView; reason: string } => Boolean(entry.reason))
      .sort((a, b) => a.item.publishAt.localeCompare(b.item.publishAt)),
    [items],
  );
  const visibleAttention = showAllPending ? attention : attention.slice(0, 3);

  const today = snapshot?.today ?? currentScheduleDate();
  const selectedDay = weekDay ?? today;
  const week = useMemo(() => weekOf(selectedDay), [selectedDay]);
  function openWeek(date: string) {
    setWeekDay(date);
    setMode("week");
  }

  return (
    <div className="min-w-0">
      <header className="mb-3 flex min-w-0 flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-text-2">Calendar</div>
          {mode === "month"
            ? <h1 className="mt-1 text-[clamp(1.9rem,3.4vw,2.4rem)] font-bold leading-[1.1] tracking-[-0.04em] text-text">{MONTHS[view.month]} <span className="text-[var(--brand)]">{view.year}</span></h1>
            : <h1 className="mt-1 text-[clamp(1.9rem,3.4vw,2.4rem)] font-bold leading-[1.1] tracking-[-0.04em] text-text">Your week, planned</h1>}
          <p className="mt-1 text-[15px] text-text-2">
            {snapshot
              ? mode === "month"
                ? `${scheduledCount} scheduled · ${approvalCount} need${approvalCount === 1 ? "s" : ""} your approval · ${draftCount} in progress · times in ${snapshot.timeZone.replace("_", " ")}`
                : "Pick a day to see everything scheduled for it."
              : "Loading your real schedule…"}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {mode === "month" ? <>
            <button type="button" aria-label="Previous month" className={ROUND} onClick={() => setCursor(shift(view, -1))}><Icon name="chevL" size={16} /></button>
            <button type="button" aria-label="Next month" className={ROUND} onClick={() => setCursor(shift(view, 1))}><Icon name="chevR" size={16} /></button>
            <button type="button" className={cx(BTN.quiet, "rounded-full")} onClick={() => snapshot && setCursor(monthOf(snapshot.today))}>Today</button>
          </> : <>
            <button type="button" aria-label="Previous week" className={ROUND} onClick={() => setWeekDay(addDaysIso(week[0], -7))}><Icon name="chevL" size={16} /></button>
            <button type="button" aria-label="Next week" className={ROUND} onClick={() => setWeekDay(addDaysIso(week[0], 7))}><Icon name="chevR" size={16} /></button>
            <button type="button" className={cx(BTN.quiet, "rounded-full")} onClick={() => setWeekDay(today)}>Jump to today</button>
          </>}
          <div className="inline-flex rounded-full border border-line bg-surface-2 p-1" role="group" aria-label="Calendar view">
            {(["week", "month"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}
                className={cx("rounded-full px-4 py-1.5 text-[14px] font-semibold transition", mode === value ? "bg-surface text-text shadow-[var(--shadow-sm)]" : "text-text-2 hover:text-text")}>
                {value === "week" ? "Week" : "Month"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-text-2">
          {([["blue", "Scheduled"], ["amber", "Needs approval"], ["green", "Published"], ["grey", "In progress"], ["red", "Failed"]] as const).map(([tone, label]) => (
            <span key={label} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px]" style={{ background: TONE_ACCENT_HEX[tone] }} />{label}</span>
          ))}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="calendar-format">Format</label>
          <select id="calendar-format" value={filter} onChange={(e) => setFilter(e.target.value)} className={cx(BTN.field, "h-10 rounded-full")}>
            {FILTERS.map((value) => <option key={value} value={value}>{value === "All" ? "All formats" : value}</option>)}
          </select>
          <button type="button" className={cx(BTN.primary, "h-10")} onClick={() => open(<CreateContentModal onChanged={() => void load()} />)}>
            <Icon name="plus" size={14} /> Create content
          </button>

        </div>
      </div>


      {error && <div role="alert" className="mb-4 rounded-[14px] border border-[var(--red)]/30 bg-[var(--red-soft)] px-4 py-3 text-[13.5px] text-[var(--red)]">{error}</div>}


      {mode === "month" ? (
        <section className="voom-card mb-5 overflow-hidden" aria-label={`${MONTHS[view.month]} ${view.year}`}>
          <div className="grid grid-cols-7 border-b border-line">
            {DOW.map((day) => <div key={day} className="px-1 py-2.5 text-center text-[11px] font-semibold uppercase tracking-[0.1em] text-text-2 sm:px-3 sm:text-left sm:text-[12px]">{day}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((cell, index) => {
              const date = cell.date;
              const events = cell.out ? [] : byDate.get(date) ?? [];
              const isToday = Boolean(snapshot) && date === snapshot!.today;
              const needsApproval = events.some((event) => event.type === "workflow" && (event.item.status === "needs_approval" || event.item.status === "ready_for_review"));
              const attentionInCell = events.filter((event) => event.type === "workflow" && attentionReason(event.item)).length;
              return (
                <div key={index} className={cx("group relative flex min-h-[64px] min-w-0 flex-col gap-1 border-b border-r border-line p-1 [&:nth-child(7n)]:border-r-0 sm:min-h-[118px] sm:p-2.5", cell.out ? "bg-surface-2/60" : isToday ? "bg-[var(--brand-soft-2)]" : "bg-surface")}>
                  <div className="flex items-center justify-between gap-1">
                    {cell.out
                      ? <span className="text-[12px] font-semibold text-text-3 sm:text-[15px]">{cell.day}</span>
                      : <button type="button" onClick={() => openWeek(date)} aria-label={`Open the week of ${date}`}
                          className={cx("inline-flex items-center gap-1.5 rounded-full text-[12px] font-semibold focus-visible:outline-2 focus-visible:outline-[var(--brand)] sm:text-[15px]", isToday ? "text-[var(--brand)]" : "text-text hover:text-[var(--brand)]")}>
                          <span className={cx("grid h-6 min-w-6 place-items-center rounded-full px-1", isToday && "voom-create-btn text-white")}>{cell.day}</span>
                          {isToday && <span className="hidden text-[12.5px] font-medium sm:inline">Today</span>}
                        </button>}
                    {needsApproval && <span className="hidden rounded-full bg-[var(--amber-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--amber)] lg:inline">Approve</span>}
                    {attentionInCell > 0 && <span aria-label={`${attentionInCell} needing attention`} className="h-1.5 w-1.5 rounded-full bg-[var(--amber)] lg:hidden" />}
                  </div>

                  {/* Mobile: one dot per real item, so a dense day is still legible in a narrow cell. */}
                  {events.length > 0 && (
                    <span className="flex flex-wrap gap-0.5 sm:hidden" aria-hidden="true">
                      {events.slice(0, 4).map((event, dotIndex) => (
                        <span key={`dot-${dotIndex}`} className="h-1.5 w-1.5 rounded-full" style={{ background: eventAccent(event) }} />
                      ))}
                      {events.length > 4 && <span className="text-[8px] font-bold text-text-3">+{events.length - 4}</span>}
                    </span>
                  )}

                  <span className="hidden min-w-0 flex-col gap-1 sm:flex">
                    {events.slice(0, 3).map((event) => (
                      <button
                        type="button"
                        key={event.type === "workflow" ? event.item.draftId : `social-${event.item.draftId}`}
                        className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden border-l-[3px] pl-1.5 text-left text-[11.5px] leading-tight text-text hover:text-[var(--brand-ink)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--brand)] lg:text-[12.5px]"
                        style={{ borderColor: eventAccent(event) }}
                        aria-label={`Open ${event.item.concept} (${event.item.contentTypeLabel}, ${event.item.statusLabel})`}
                        title={eventTitle(event)}
                        onClick={() => openEvent(event, open, load)}
                      >
                        <span className="truncate"><b className="font-semibold">{event.item.localTime}</b> {event.item.concept}</span>
                        {confirmedOf(event) && <Icon name="shield" size={10} className="flex-none text-[var(--green)]" />}
                      </button>
                    ))}
                    {events.length > 3 && <button type="button" onClick={() => openWeek(date)} className="pl-2 text-left text-[11px] font-semibold text-text-3 hover:text-[var(--brand-ink)]">+{events.length - 3} more</button>}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="hidden px-4 py-3 text-right text-[13px] text-text-2 sm:block">Click any day to open it in the weekly view.</p>

          {/* Mobile keeps the day list explicit: dots alone never hide what is scheduled. */}
          <ul className="min-w-0 space-y-1.5 p-2.5 sm:hidden">
            {cells.flatMap((cell) => cell.out ? [] : (byDate.get(cell.date) ?? []).map((event) => ({ date: cell.date, event })))
              .slice(0, 8)
              .map(({ date, event }) => (
                <li key={`mobile-${date}-${event.item.draftId}`}>
                  <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-[12px] border border-line bg-surface px-3 py-2 text-left" onClick={() => openEvent(event, open, load)}>
                    <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full" style={{ background: eventAccent(event) }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-semibold text-text">{event.item.dayLabel} {event.item.localTime} · {event.item.concept}</span>
                      <span className="block truncate text-[11.5px] text-text-3">{channelIdentity(channelOf(event)).label} · {event.item.contentTypeLabel} · {event.item.statusLabel}</span>
                    </span>
                    {confirmedOf(event) && <Icon name="shield" size={12} className="flex-none text-[var(--green)]" />}
                  </button>
                </li>
              ))}
          </ul>

          {snapshot && totalVisible === 0 && <EmptyCalendar onCreate={() => open(<CreateContentModal onChanged={() => void load()} />)} />}
        </section>
      ) : (
        <WeekView
          week={week}
          selectedDay={selectedDay}
          today={today}
          byDate={byDate}
          onSelect={setWeekDay}
          onOpen={(event) => openEvent(event, open, load)}
          onCreate={() => open(<CreateContentModal onChanged={() => void load()} />)}
          onMonth={() => { setMode("month"); setCursor(monthOf(selectedDay)); }}
          empty={Boolean(snapshot) && totalVisible === 0}
        />
      )}

      {attention.length > 0 && (
        <section className="mb-5 rounded-[18px] bg-[var(--coral-soft)] px-5 py-4" aria-labelledby="calendar-attention">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="calendar-attention" className="flex items-center gap-2 text-[15px] font-semibold text-text"><Icon name="warn" size={16} className="text-[var(--coral)]" />
              {attention.length} item{attention.length === 1 ? "" : "s"} need{attention.length === 1 ? "s" : ""} your attention</h2>
            {attention.length > 3 && <button type="button" className="text-[13px] font-semibold text-[var(--brand-ink)] hover:underline" onClick={() => setShowAllPending((value) => !value)}>{showAllPending ? "Show fewer" : `Show all ${attention.length}`}</button>}
          </div>
          <p className="mt-0.5 text-[12.5px] text-text-2">Real state from the workflow — nothing here is inferred from a timer alone.</p>
          <ul className="mt-3 min-w-0 space-y-2">
            {visibleAttention.map(({ item, reason }) => (
              <li key={`attn-${item.draftId}`} className="flex min-w-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <ChannelGlyph channel={item.channel} size={20} />
                  <span className="truncate text-[13px] font-semibold text-text">{item.concept}</span>
                  <span className="text-[12px] text-text-3">{item.dayLabel} · {item.localTime}</span>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <p className="min-w-0 text-[12.5px] leading-relaxed text-text-2 sm:max-w-[52%]">{reason}</p>
                  <button type="button" className={cx(BTN.outline, "h-9 px-4")} onClick={() => openEvent({ type: "workflow", item }, open, load)}>Open</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mb-5">
        <PublishingQueue />
      </div>

      <section className="voom-card p-5 sm:p-6" aria-labelledby="calendar-legend">
        <h2 id="calendar-legend" className="text-[16px] font-semibold text-text">How to read this calendar</h2>
        <p className="mt-0.5 text-[13px] text-text-2">Voom only ever claims what a provider confirmed: scheduled is not submitted, submitted is not accepted, and accepted is not published.</p>
        <div className="mt-4 grid min-w-0 gap-2.5 sm:grid-cols-3">
          <StateNote status="scheduled" label="Scheduled" text="The time and channel are set. Nothing has been handed to the provider yet." />
          <StateNote status="publishing" label="Publishing" text="Voom submitted it and the provider is processing it. Not published yet." />
          <StateNote status="published" label="Published" text="The provider itself confirmed it. Instagram shows Meta-confirmed; TikTok and YouTube show provider-confirmed." />
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-text-3">
          {WORKFLOW_STATUSES.map((status) => counts[status] ?? 0).reduce((total, value) => total + value, 0) > 0
            ? "Counts above come from the live workflow items on screen — no separate tally exists."
            : "Items appear here the moment the Marketing Plan, the Studio or an approval creates real work."}
        </p>
      </section>
    </div>
  );
}

const ROUND = "grid h-10 w-10 place-items-center rounded-full border border-line bg-surface text-text-2 transition hover:bg-surface-2 hover:text-text";

function EmptyCalendar({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 border-t border-line p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="text-[15px] font-semibold text-text">Your calendar is empty</h3>
        <p className="mt-0.5 max-w-xl text-[13px] leading-relaxed text-text-2">This calendar shows the content Voom is actually executing — planned drafts, items waiting for your approval, and what is scheduled or published, across Instagram, TikTok and YouTube. Build your rolling plan, or create content directly, and each item appears here with its real status.</p>
      </div>
      <button type="button" className={BTN.outline} onClick={onCreate}><Icon name="plus" size={14} /> Create content</button>
    </div>
  );
}

/**
 * Week view (Figma "Your week, planned"): seven real days — the selected day
 * is lifted like the reference's card deck — then that day's items, this
 * week's items waiting for approval, and the rest of the week. Every card is
 * a real item and opens the same editor as the month view. The reference's
 * "Best time" hint and List view are not shown: Voom computes neither.
 */
function WeekView({ week, selectedDay, today, byDate, onSelect, onOpen, onCreate, onMonth, empty }: {
  week: string[];
  selectedDay: string;
  today: string;
  byDate: Map<string, CalendarEvent[]>;
  onSelect: (date: string) => void;
  onOpen: (event: CalendarEvent) => void;
  onCreate: () => void;
  onMonth: () => void;
  empty: boolean;
}) {
  const weekEvents = week.flatMap((date) => (byDate.get(date) ?? []).map((event) => ({ date, event })));
  const dayEvents = byDate.get(selectedDay) ?? [];
  const approvals = weekEvents.filter(({ event }) => event.type === "workflow" && (event.item.status === "needs_approval" || event.item.status === "ready_for_review"));
  const later = weekEvents.filter(({ date }) => date > selectedDay);
  return (
    <div className="mb-5 min-w-0 space-y-6">
      <section className="voom-card min-w-0 overflow-hidden px-3 py-5 sm:px-6" aria-label="This week">
        <div className="text-center">
          <h2 className="text-[22px] font-bold tracking-[-0.03em] text-text">{week.includes(today) ? "This week" : "Week of " + shortDate(week[0])}</h2>
          <p className="text-[13px] text-text-2">{shortDate(week[0])} to {shortDate(week[6])}</p>
        </div>
        <ol className="mt-5 grid grid-cols-7 items-end gap-1 sm:gap-2.5 lg:gap-3">
          {week.map((date) => {
            const events = byDate.get(date) ?? [];
            const selected = date === selectedDay;
            const pending = events.filter((event) => event.type === "workflow" && (event.item.status === "needs_approval" || event.item.status === "ready_for_review")).length;
            return (
              <li key={date} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onSelect(date)}
                  aria-pressed={selected}
                  aria-label={`${weekdayOf(date)} ${shortDate(date)}: ${events.length} item${events.length === 1 ? "" : "s"}`}
                  className={cx(
                    "flex w-full min-w-0 flex-col rounded-[14px] p-1.5 text-left transition sm:rounded-[20px] sm:p-3.5 lg:min-h-[176px]",
                    selected ? "voom-create-btn text-white shadow-[0_18px_36px_-18px_rgba(134,69,250,.9)] lg:-translate-y-3"
                      : events.length ? "bg-[linear-gradient(160deg,#2a1d63,#141026)] text-white hover:brightness-110"
                      : "border border-line bg-surface text-text-3 hover:border-[var(--brand-line)]",
                  )}
                >
                  <span className="flex items-center justify-between gap-1">
                    <span className="text-[10.5px] font-medium sm:text-[13px]">{weekdayOf(date)}</span>
                    {date === today && <span className="hidden rounded-full bg-white/25 px-2 py-0.5 text-[11px] font-semibold lg:inline">Today</span>}
                  </span>
                  <span className="mt-0.5 text-[20px] font-bold leading-none tracking-[-0.04em] sm:mt-1 sm:text-[34px] lg:text-[44px]">{Number(date.slice(8))}</span>
                  <span className="mt-1 hidden text-[12.5px] sm:block">{pending ? `${pending} to approve` : events.length ? `${events.length} post${events.length === 1 ? "" : "s"}` : "Open slot"}</span>
                  <span className="mt-auto hidden flex-wrap gap-1 pt-3 lg:flex">
                    {[...new Set(events.map((event) => channelOf(event)))].slice(0, 3).map((channel) => <ChannelGlyph key={channel} channel={channel} size={20} />)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>

      <WeekGroup icon="cal" title={selectedDay === today ? "Today" : weekdayOf(selectedDay)} hint={`${longDate(selectedDay)} · ${dayEvents.length} item${dayEvents.length === 1 ? "" : "s"}`}>
        {dayEvents.map((event) => <EventCard key={`day-${event.item.draftId}`} event={event} onOpen={onOpen} />)}
        <button type="button" onClick={onCreate} className="flex min-h-[132px] flex-col justify-center rounded-[18px] border border-dashed border-[var(--brand-line)] bg-[var(--brand-soft-2)] p-4 text-left transition hover:bg-[var(--brand-soft)]">
          <span className="grid h-9 w-9 place-items-center rounded-[10px] border border-[var(--brand-line)] bg-surface text-[var(--brand-ink)]"><Icon name="plus" size={16} /></span>
          <b className="mt-3 text-[15px] font-semibold text-[var(--brand-ink)]">Add content</b>
          <span className="text-[12.5px] text-text-2">Opens Create on any format.</span>
        </button>
      </WeekGroup>

      {approvals.length > 0 && (
        <WeekGroup icon="sparkles" title="Needs your approval" hint={`${approvals.length} waiting on you`} action={<Link href="/app/approvals" className="text-[13.5px] font-semibold text-[var(--brand-ink)] hover:underline">Review all</Link>}>
          {approvals.map(({ event }) => <EventCard key={`appr-${event.item.draftId}`} event={event} onOpen={onOpen} />)}
        </WeekGroup>
      )}

      <WeekGroup icon="clock" title="Later this week" hint={later.length ? `${later.length} still to go out` : "Nothing else this week"} action={<button type="button" onClick={onMonth} className="text-[13.5px] font-semibold text-[var(--brand-ink)] hover:underline">See the full month</button>}>
        {later.length ? later.map(({ event }) => <EventCard key={`later-${event.item.draftId}`} event={event} onOpen={onOpen} />)
          : <p className="col-span-full text-[13.5px] text-text-2">{empty ? "Nothing is planned yet. Build your plan in Marketing Plan or create content directly." : "No more items after this day in the selected week."}</p>}
      </WeekGroup>
    </div>
  );
}

function WeekGroup({ icon, title, hint, action, children }: { icon: string; title: string; hint: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[19px] font-semibold tracking-[-0.02em] text-text">
          <Icon name={icon} size={18} className="text-[var(--brand)]" /> {title}
          <span className="text-[13px] font-normal text-text-2">{hint}</span>
        </h2>
        {action}
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-4">{children}</div>
    </section>
  );
}

function EventCard({ event, onOpen }: { event: CalendarEvent; onOpen: (event: CalendarEvent) => void }) {
  const tone = eventTone(event);
  return (
    <button type="button" onClick={() => onOpen(event)} title={eventTitle(event)}
      className="voom-card flex min-h-[132px] min-w-0 flex-col p-4 text-left transition hover:border-[var(--brand-line)]">
      <span className="flex items-center justify-between gap-2">
        <ChannelGlyph channel={channelOf(event)} size={24} />
        <Icon name="chevR" size={15} className="text-text-3" />
      </span>
      <b className="mt-3 line-clamp-2 text-[15px] font-semibold leading-snug text-text">{event.item.concept}</b>
      <span className="mt-0.5 text-[12.5px] text-text-2">{event.item.dayLabel} · {event.item.localTime} · {channelIdentity(channelOf(event)).label}</span>
      <span className="mt-auto pt-3"><StatusChip status={event.type === "workflow" ? event.item.status : tone === "green" ? "published" : tone === "red" ? "failed" : "scheduled"} label={event.item.statusLabel} small /></span>
    </button>
  );
}

function StateNote({ status, label, text }: { status: string; label: string; text: string }) {
  return <div className="min-w-0 rounded-xl border border-line bg-surface-2 p-3">
    <StatePill status={status} label={label} dense />
    <p className="mt-1.5 text-[12px] leading-relaxed text-text-2">{text}</p>
  </div>;
}

function openEvent(event: CalendarEvent, open: ReturnType<typeof useModal>["open"], load: () => Promise<void> | void) {
  if (event.type === "social") {
    open(<SocialEditorModal draftId={event.item.draftId} onChanged={() => void load()} />);
    return;
  }
  if (event.item.channel !== "instagram") {
    open(<SocialEditorModal draftId={event.item.draftId} onChanged={() => void load()} />);
    return;
  }
  if (event.item.calendarItemId) {
    open(<SavedCalendarDetailModal itemId={event.item.calendarItemId} />);
    return;
  }
  open(<WorkflowDetail item={event.item} />);
}

function WorkflowDetail({ item }: { item: WorkflowView }) {
  const { close } = useModal();
  const pastDue = (item.status === "scheduled" || item.status === "publishing") && isPastInstant(item.publishAt);
  const confirmed = providerConfirmationLabel(item.channel, { instagramMediaId: item.instagramMediaId, queueStatus: item.queueStatus });
  return <div className="max-w-lg rounded-[var(--r)] border border-line bg-surface p-5">
    <div className="flex flex-wrap items-center gap-2">
      <ChannelPill channel={item.channel} format={item.format} dense />
      <StatePill status={item.status} label={item.statusLabel} dense />
      {confirmed && <Tag tone="t-green">{confirmed}</Tag>}
      {item.status === "missed" && <Tag tone="t-red">Missed scheduled time</Tag>}
    </div>
    <h2 className="mt-3 font-display text-lg font-semibold">{item.concept}</h2>
    <p className="mt-1 text-sm text-text-3">{item.dayLabel} · {item.localTime}</p>
    {item.status === "waiting_for_media" && <p role="status" className="mt-3 rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-sm text-amber">
      This item is scheduled, but it cannot publish until the visual is ready — Voom is holding the schedule until the media is stored.
    </p>}
    {item.status === "media_delayed" && <p role="alert" className="mt-3 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">
      Media generation is delayed, so this schedule is held — Voom will not publish until a real visual exists. Retry the generation, upload a replacement, or cancel it from the Marketing Plan.
    </p>}
    {item.status === "media_timed_out" && <p role="alert" className="mt-3 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">
      That generation ran past Voom&apos;s {MEDIA_GENERATION_HARD_TIMEOUT_MINUTES}-minute limit, so it cannot finish and this schedule stays held — nothing was published and nothing new was charged. Retry it as a new generation, upload a replacement, or cancel it from the Marketing Plan.
    </p>}
    {item.status === "missed" && <p role="alert" className="mt-3 rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-sm text-amber">
      {item.missedReason ?? "Its scheduled time passed without publishing."} Voom never publishes hours late on its own — post it now or reschedule from the Marketing Plan.
    </p>}
    {pastDue && item.status !== "missed" && <p className="mt-3 rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-sm text-amber">
      This item is past its scheduled time. It stays right here until Voom completes it — it is never silently dropped or published twice.
    </p>}
    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-text-2">{item.caption}</p>
    <p className="mt-3 text-[11.5px] text-text-3">{item.sourceLabel} · {item.contentTypeLabel}</p>
    {item.failedStage && <p role="alert" className="mt-3 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">
      {item.failedStage === "media" ? "Media generation stopped safely. Nothing was published and you can retry without paying twice."
        : item.failedStage === "publishing" ? (item.failureMessage ?? "Publishing stopped safely. Nothing was published twice.")
        : "This item was rejected, so it will not publish."}
    </p>}
    <Btn className="mt-4" variant="outline" size="sm" onClick={close}>Close</Btn>
  </div>;
}

function monthOf(date: string) {
  const [year, month] = date.split("-").map(Number);
  return { year, month: month - 1 };
}
function shift(view: { month: number; year: number }, delta: number) {
  const value = view.month + delta;
  if (value < 0) return { month: 11, year: view.year - 1 };
  if (value > 11) return { month: 0, year: view.year + 1 };
  return { month: value, year: view.year };
}
function buildCells(year: number, month: number) {
  // Weeks start on Monday, as in the reference.
  const first = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const prev = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: { day: number; out: boolean; date: string }[] = [];
  for (let index = first - 1; index >= 0; index -= 1) cells.push({ day: prev - index, out: true, date: "" });
  for (let day = 1; day <= days; day += 1) cells.push({ day, out: false, date: iso(year, month, day) });
  while (cells.length % 7) cells.push({ day: cells.length - days - first + 1, out: true, date: "" });
  return cells;
}
/** The seven local dates (Mon–Sun) of the week containing `date`. */
function weekOf(date: string): string[] {
  const [year, month, day] = date.split("-").map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  const monday = addDaysIso(date, -((at.getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => addDaysIso(monday, index));
}
function addDaysIso(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const at = new Date(Date.UTC(year, month - 1, day + days));
  return iso(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}
function weekdayOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}
function shortDate(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[month - 1].slice(0, 3)}`;
}
function longDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${weekdayOf(date)} ${day} ${MONTHS[month - 1]} ${year}`;
}
function iso(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function countByStatus(items: WorkflowView[]) {
  return items.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {});
}

/**
 * The tone of one calendar entry. Workflow items use their authoritative
 * status; TikTok/YouTube items use their durable queue state. Both are the
 * real reads — a label string is never pattern-matched into a colour.
 */
function eventTone(event: CalendarEvent): WorkspaceTone {
  return event.type === "workflow" ? workflowTone(event.item.status) : socialQueueTone(event.item.queueStatus);
}

/** Colour for a calendar entry — real state first, channel identity as the band. */
function eventAccent(event: CalendarEvent): string {
  const tone = eventTone(event);
  if (tone !== "grey") return TONE_ACCENT_HEX[tone];
  return CHANNEL_ACCENT_HEX[channelIdentity(channelOf(event)).key as ChannelKey] ?? TONE_ACCENT_HEX.grey;
}
