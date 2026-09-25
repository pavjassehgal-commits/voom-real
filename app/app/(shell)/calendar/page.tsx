"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { CreateContentModal } from "@/components/voom/modals/CreateContentModal";
import { SavedCalendarDetailModal } from "@/components/voom/modals/SavedCalendarDetailModal";
import { SocialEditorModal } from "@/components/voom/modals/SocialEditorModal";
import { Btn, Chip, IconBtn, Tag } from "@/components/voom/ui/primitives";
import { currentScheduleDate } from "@/lib/voom/schedule-guard";
import { PublishingQueue } from "@/components/voom/PublishingQueue";
import type { WorkflowSnapshot, WorkflowView } from "@/lib/voom/workflow/read";
import { MEDIA_GENERATION_HARD_TIMEOUT_MINUTES, WORKFLOW_STATUSES } from "@/lib/voom/workflow/state";
import { isPastInstant } from "@/lib/voom/schedule-guard";
import type { SocialCalendarItemView } from "@/lib/social/server-drafts";
import {
  ChannelPill,
  MetaChip,
  Panel,
  PanelHead,
  QuietState,
  StatePill,
  WorkspaceFrame,
  WorkspaceHeader,
} from "@/components/voom/workspace/ui";
import {
  CHANNEL_ACCENT_HEX,
  STATE_GROUP_LABELS,
  channelIdentity,
  providerConfirmationLabel,
  socialQueueTone,
  stateGroup,
  TONE_ACCENT_HEX,
  workflowTone,
  type ChannelKey,
  type StateGroup,
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
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

export default function CalendarPage() {
  const { open } = useModal();
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null);
  const [socialItems, setSocialItems] = useState<SocialCalendarItemView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("All");
  const [cursor, setCursor] = useState<{ month: number; year: number } | null>(null);
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
  const nativePlanCount = items.filter((item) => item.channel !== "instagram").length;
  const totalVisible = items.length + socialCells.length;

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
  const groups = useMemo(() => groupCounts(counts), [counts]);
  const visibleAttention = showAllPending ? attention : attention.slice(0, 3);

  return (
    <WorkspaceFrame>
      <WorkspaceHeader
        eyebrow="Content Calendar"
        title="What is happening, where, and when."
        question={snapshot
          ? `${totalVisible} item${totalVisible === 1 ? "" : "s"} on the real schedule · ${snapshot.cadenceLabel} · times in ${snapshot.timeZone.replace("_", " ")}`
          : "Loading your real schedule…"}
        description="Every entry below is the same record Voom will execute — the Marketing Plan item, the approved draft and the provider queue row are one piece of work."
        meta={<>
          <MetaChip accent><Icon name="cal" size={12} /> {MONTHS[view.month]} {view.year}</MetaChip>
          {attention.length > 0
            ? <MetaChip><span className="text-[var(--amber)]">{attention.length} need{attention.length === 1 ? "s" : ""} attention</span></MetaChip>
            : snapshot ? <MetaChip><span className="text-[var(--green)]">Nothing needs attention</span></MetaChip> : null}
          {nativePlanCount + socialCells.length > 0 && <MetaChip>{nativePlanCount + socialCells.length} TikTok / YouTube</MetaChip>}
        </>}
        actions={<Btn variant="brand" size="sm" onClick={() => open(<CreateContentModal onChanged={() => void load()} />)}>
          <Icon name="plus" size={14} /> Create content
        </Btn>}
      />

      {error && <div role="alert" className="relative z-10 mb-3.5 rounded-2xl border border-red/35 bg-red/10 px-4 py-3 text-[13px] text-red">{error}</div>}

      {attention.length > 0 && (
        <Panel className="relative z-10 mb-3.5 border-amber/35 bg-[var(--amber-soft)]">
          <PanelHead
            icon="warn"
            title={`${attention.length} item${attention.length === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} your attention`}
            hint="Real state from the workflow — nothing here is inferred from a timer alone."
            action={attention.length > 3
              ? <Btn variant="ghost" size="sm" onClick={() => setShowAllPending((value) => !value)}>{showAllPending ? "Show fewer" : `Show all ${attention.length}`}</Btn>
              : undefined}
          />
          <ul className="mt-3 min-w-0 space-y-2">
            {visibleAttention.map(({ item, reason }) => (
              <li key={`attn-${item.draftId}`} className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-[var(--surface)]/70 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <ChannelPill channel={item.channel} format={item.format} dense />
                  <span className="text-[12px] font-semibold text-text-2 truncate">{item.concept}</span>
                  <span className="text-[11.5px] text-text-3">{item.dayLabel} · {item.localTime}</span>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <p className="min-w-0 text-[12px] leading-relaxed text-text-2 sm:max-w-[52%]">{reason}</p>
                  <Btn variant="outline" size="sm" onClick={() => openEvent({ type: "workflow", item }, open, load)}>
                    Open
                  </Btn>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel className="relative z-10 mb-3.5" padded={false}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2.5 p-3.5 sm:p-4">
          {/* Month navigation: the label takes the space that is left and wraps
              the controls to a second line on a narrow phone rather than
              pushing "Today" past the viewport. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none">
            <IconBtn aria-label="Previous month" onClick={() => setCursor(shift(view, -1))}><Icon name="back" /></IconBtn>
            <b className="min-w-0 flex-1 truncate text-center font-display text-[16px] font-semibold tracking-[-0.02em] sm:min-w-[150px] sm:flex-none">{MONTHS[view.month]} {view.year}</b>
            <IconBtn aria-label="Next month" onClick={() => setCursor(shift(view, 1))}><Icon name="arrow" /></IconBtn>
            <Btn variant="ghost" size="sm" onClick={() => snapshot && setCursor(monthOf(snapshot.today))}>Today</Btn>
          </div>
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {FILTERS.map((value) => <Chip key={value} active={filter === value} onClick={() => setFilter(value)}>{value}</Chip>)}
          </div>
        </div>

        {groups.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-3.5 py-2.5 sm:px-4">
            {groups.map((group) => (
              <span key={group.group} className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-text-3">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: groupAccent(group.group) }} />
                {STATE_GROUP_LABELS[group.group]} <b className="text-text-2">{group.count}</b>
              </span>
            ))}
          </div>
        )}

        <div className="border-t border-line p-2.5 sm:p-3.5">
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-[16px] border border-line bg-line">
            {DOW.map((day) => <div key={day} className="bg-surface-2 py-2 text-center text-[10.5px] font-bold uppercase tracking-[.06em] text-text-3 sm:py-2.5 sm:text-[11px]">{day}</div>)}
            {cells.map((cell, index) => {
              const date = cell.date;
              const events = cell.out ? [] : byDate.get(date) ?? [];
              const isToday = Boolean(snapshot) && date === snapshot!.today;
              const attentionInCell = events.filter((event) => event.type === "workflow" && attentionReason(event.item)).length;
              return <div key={index} className={`group flex min-h-[64px] min-w-0 flex-col gap-1 bg-surface p-1 sm:min-h-[116px] sm:p-1.5 ${cell.out ? "bg-surface-2 opacity-50" : "hover:bg-surface-2"}`}>
                <div className="flex items-center justify-between gap-1">
                  <span className={`grid h-[21px] w-[21px] place-items-center rounded-lg text-[11.5px] font-semibold ${isToday ? "voom-grad text-white" : "text-text-2"}`}>{cell.day}</span>
                  {attentionInCell > 0 && <span aria-label={`${attentionInCell} needing attention`} className="h-1.5 w-1.5 rounded-full bg-[var(--amber)]" />}
                </div>

                {/* Mobile: one dot per real item, so a dense day is still legible in a 40px cell. */}
                {events.length > 0 && (
                  <span className="flex flex-wrap gap-0.5 sm:hidden" aria-hidden="true">
                    {events.slice(0, 4).map((event, dotIndex) => (
                      <span key={`dot-${dotIndex}`} className="h-1.5 w-1.5 rounded-full" style={{ background: eventAccent(event) }} />
                    ))}
                    {events.length > 4 && <span className="text-[8px] font-bold text-text-3">+{events.length - 4}</span>}
                  </span>
                )}

                <span className="hidden min-w-0 flex-col gap-0.5 sm:flex">
                  {events.slice(0, 3).map((event) => (
                    <button
                      type="button"
                      key={event.type === "workflow" ? event.item.draftId : `social-${event.item.draftId}`}
                      className="flex w-full min-w-0 items-center gap-1 overflow-hidden rounded-[7px] px-1.5 py-1 text-left text-[9.5px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand lg:text-[11px]"
                      style={{ background: `${eventAccent(event)}1f`, color: eventAccent(event) }}
                      aria-label={`Open ${event.item.concept} (${event.item.contentTypeLabel}, ${event.item.statusLabel})`}
                      title={eventTitle(event)}
                      onClick={() => openEvent(event, open, load)}
                    >
                      <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: eventAccent(event) }} />
                      <span className="truncate">{event.item.localTime} · {event.item.contentTypeLabel} · {event.item.concept}</span>
                      {confirmedOf(event) && <Icon name="shield" size={10} className="flex-none" />}
                    </button>
                  ))}
                  {events.length > 3 && <span className="pl-1 text-[10px] text-text-3">+{events.length - 3} more</span>}
                </span>
              </div>;
            })}
          </div>

          {/* Mobile keeps the day list explicit: dots alone never hide what is scheduled. */}
          <ul className="mt-3 min-w-0 space-y-1.5 sm:hidden">
            {cells.flatMap((cell) => cell.out ? [] : (byDate.get(cell.date) ?? []).map((event) => ({ date: cell.date, event })))
              .slice(0, 8)
              .map(({ date, event }) => (
                <li key={`mobile-${date}-${event.type === "workflow" ? event.item.draftId : event.item.draftId}`}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-left"
                    onClick={() => openEvent(event, open, load)}
                  >
                    <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full" style={{ background: eventAccent(event) }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-semibold text-text">{event.item.localTime} · {event.item.concept}</span>
                      <span className="block truncate text-[11.5px] text-text-3">{channelIdentity(channelOf(event)).label} · {event.item.contentTypeLabel} · {event.item.statusLabel}</span>
                    </span>
                    {confirmedOf(event) && <Icon name="shield" size={12} className="flex-none text-[var(--green)]" />}
                  </button>
                </li>
              ))}
          </ul>

          {snapshot && totalVisible === 0 && (
            <QuietState
              icon="cal"
              title="Your calendar is empty"
              action={<Btn variant="outline" size="sm" onClick={() => open(<CreateContentModal onChanged={() => void load()} />)}>
                <Icon name="plus" size={14} /> Create content
              </Btn>}
            >
              <p>This calendar shows the content Voom is actually executing — planned drafts, items waiting for your approval, and what is scheduled or published, across Instagram, TikTok and YouTube.</p>
              <p className="mt-1.5">Build your rolling plan, or create content directly, and each item appears here with its real status.</p>
            </QuietState>
          )}
        </div>
      </Panel>

      <div className="relative z-10">
        <PublishingQueue />
      </div>

      <Panel className="relative z-10 mt-3.5">
        <PanelHead
          icon="target"
          title="How to read this calendar"
          hint="Voom only ever claims what a provider confirmed: scheduled is not submitted, submitted is not accepted, and accepted is not published."
        />
        <div className="mt-3 grid min-w-0 gap-2.5 sm:grid-cols-3">
          <StateNote status="scheduled" label="Scheduled" text="The time and channel are set. Nothing has been handed to the provider yet." />
          <StateNote status="publishing" label="Publishing" text="Voom submitted it and the provider is processing it. Not published yet." />
          <StateNote status="published" label="Published" text="The provider itself confirmed it. Instagram shows Meta-confirmed; TikTok and YouTube show provider-confirmed." />
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-text-3">
          {WORKFLOW_STATUSES.map((status) => counts[status] ?? 0).reduce((total, value) => total + value, 0) > 0
            ? "Counts above come from the live workflow items on screen — no separate tally exists."
            : "Items appear here the moment the Marketing Plan, the Studio or an approval creates real work."}
        </p>
      </Panel>
    </WorkspaceFrame>
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
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const prev = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: { day: number; out: boolean; date: string }[] = [];
  for (let index = first - 1; index >= 0; index -= 1) cells.push({ day: prev - index, out: true, date: "" });
  for (let day = 1; day <= days; day += 1) cells.push({ day, out: false, date: iso(year, month, day) });
  while (cells.length % 7) cells.push({ day: cells.length - days - first + 1, out: true, date: "" });
  return cells;
}
function iso(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function countByStatus(items: WorkflowView[]) {
  return items.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {});
}

/** The ONE state vocabulary, grouped for the legend strip — counts of real rows. */
const STATE_GROUP_ORDER: StateGroup[] = ["attention", "review", "live", "ready", "open"];
function groupCounts(counts: Record<string, number>): { group: StateGroup; count: number }[] {
  const totals = new Map<StateGroup, number>();
  for (const [status, count] of Object.entries(counts)) {
    const group = stateGroup(status);
    totals.set(group, (totals.get(group) ?? 0) + count);
  }
  return STATE_GROUP_ORDER
    .map((group) => ({ group, count: totals.get(group) ?? 0 }))
    .filter((entry) => entry.count > 0);
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
function groupAccent(group: StateGroup): string {
  if (group === "attention") return "var(--amber)";
  if (group === "review") return "var(--amber)";
  if (group === "live") return "var(--blue)";
  if (group === "ready") return "var(--brand)";
  return "var(--line-strong)";
}
