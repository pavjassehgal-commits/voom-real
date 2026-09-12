"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { CreateContentModal } from "@/components/voom/modals/CreateContentModal";
import { SavedCalendarDetailModal } from "@/components/voom/modals/SavedCalendarDetailModal";
import { Btn, Card, Chip, EmptyState, IconBtn, Tag } from "@/components/voom/ui/primitives";
import { currentScheduleDate } from "@/lib/voom/schedule-guard";
import { PublishingQueue } from "@/components/voom/PublishingQueue";
import type { WorkflowSnapshot, WorkflowView } from "@/lib/voom/workflow/read";
import { WORKFLOW_STATUS_LABELS, WORKFLOW_STATUSES } from "@/lib/voom/workflow/state";
import { isPastInstant } from "@/lib/voom/schedule-guard";

/**
 * The Content Calendar is the authoritative visual schedule of the ONE
 * executable content workflow. Every cell entry is a real workflow item with
 * its real local scheduled time and real status; clicking one opens the real
 * draft. There is no sample dataset and no hardcoded month.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const FILTERS = ["All", "Instagram Post", "Reel", "Instagram Story"] as const;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function CalendarPage() {
  const { open } = useModal();
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("All");
  const [cursor, setCursor] = useState<{ month: number; year: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/voom/workflow", { cache: "no-store" });
      const body = await response.json() as { snapshot?: WorkflowSnapshot; error?: string };
      if (!response.ok || !body.snapshot) throw new Error(body.error ?? "Your schedule couldn't load.");
      setSnapshot(body.snapshot);
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
  const byDate = useMemo(() => {
    const map = new Map<string, WorkflowView[]>();
    for (const item of items) map.set(item.localDate, [...(map.get(item.localDate) ?? []), item]);
    return map;
  }, [items]);

  // Fallback before the first snapshot arrives: the real current local date,
  // not a hardcoded month and not the device's UTC date.
  const view = cursor ?? monthOf(currentScheduleDate());
  const cells = useMemo(() => buildCells(view.year, view.month), [view.year, view.month]);
  const counts = useMemo(() => countByStatus(items), [items]);

  return <div>
    <PageHead
      title="Content calendar"
      description={snapshot
        ? `${items.length} workflow item${items.length === 1 ? "" : "s"} · ${snapshot.cadenceLabel} · times shown in ${snapshot.timeZone.replace("_", " ")}`
        : "Loading your real schedule…"}
      actions={<Btn variant="primary" size="sm" onClick={() => open(<CreateContentModal onChanged={() => void load()} />)}>
        <Icon name="plus" size={14} /> Create content
      </Btn>}
    />

    <PublishingQueue />

    {error && <div role="alert" className="mb-3 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>}

    <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2.5">
      <div className="flex items-center gap-2">
        <IconBtn onClick={() => setCursor(shift(view, -1))}><Icon name="back" /></IconBtn>
        <b className="min-w-[170px] text-center font-display text-lg">{MONTHS[view.month]} {view.year}</b>
        <IconBtn onClick={() => setCursor(shift(view, 1))}><Icon name="arrow" /></IconBtn>
        <Btn variant="ghost" size="sm" onClick={() => snapshot && setCursor(monthOf(snapshot.today))}>Today</Btn>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((value) => <Chip key={value} active={filter === value} onClick={() => setFilter(value)}>{value}</Chip>)}
      </div>
    </div>

    {snapshot && items.length === 0 && (
      <Card className="mb-3.5">
        <EmptyState
          icon="cal"
          title="Your calendar is empty"
          reason="This calendar shows the content Voom is actually executing — planned drafts, items waiting for your approval, and what is scheduled or published. Build your rolling plan, or create content directly, and items appear here with their real status."
          action={<Btn variant="outline" size="sm" onClick={() => open(<CreateContentModal onChanged={() => void load()} />)}>
            <Icon name="plus" size={14} /> Create content
          </Btn>}
        />
      </Card>
    )}

    <div className="grid grid-cols-7 gap-px overflow-hidden rounded-[var(--r)] border border-line bg-line">
      {DOW.map((day) => <div key={day} className="bg-surface-2 py-2.5 text-center text-[11px] font-bold uppercase tracking-[.06em] text-text-3">{day}</div>)}
      {cells.map((cell, index) => {
        const date = cell.date;
        const events = cell.out ? [] : byDate.get(date) ?? [];
        const isToday = Boolean(snapshot) && date === snapshot!.today;
        return <div key={index} className={`group flex min-h-[74px] flex-col gap-1 bg-surface p-1.5 sm:min-h-[118px] ${cell.out ? "bg-surface-2 opacity-50" : ""}`}>
          <div className="flex items-center justify-between">
            <span className={`grid h-[23px] w-[23px] place-items-center rounded-lg text-xs font-semibold ${isToday ? "voom-grad text-white" : "text-text-2"}`}>{cell.day}</span>
          </div>
          {events.slice(0, 3).map((item) => <button
            type="button"
            key={item.draftId}
            className="flex w-full items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-[7px] px-1.5 py-1 text-left text-[9.5px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand sm:px-2 sm:text-[11px]"
            style={{ background: `${colorFor(item.status)}1f`, color: colorFor(item.status) }}
            aria-label={`Open ${item.concept}`}
            onClick={() => item.calendarItemId
              ? open(<SavedCalendarDetailModal itemId={item.calendarItemId} />)
              : open(<WorkflowDetail item={item} />)}
          >
            {item.localTime} · {item.contentTypeLabel} · {item.concept}
          </button>)}
          {events.length > 3 && <span className="pl-1 text-[10px] text-text-3">+{events.length - 3} more</span>}
        </div>;
      })}
    </div>

    <div className="mt-3.5 grid gap-3.5 sm:grid-cols-3 lg:grid-cols-4">
      {WORKFLOW_STATUSES.map((status) => <Card key={status} className="flex items-center justify-between p-4">
        <div>
          <Tag tone={toneFor(status)}>{WORKFLOW_STATUS_LABELS[status]}</Tag>
          <div className="mt-2 font-display text-2xl">{counts[status] ?? 0}</div>
        </div>
      </Card>)}
    </div>
  </div>;
}

function WorkflowDetail({ item }: { item: WorkflowView }) {
  const { close } = useModal();
  const pastDue = (item.status === "scheduled" || item.status === "publishing") && isPastInstant(item.publishAt);
  return <div className="max-w-lg rounded-[var(--r)] border border-line bg-surface p-5">
    <div className="flex flex-wrap items-center gap-2">
      <Tag tone="t-blue">{item.contentTypeLabel}</Tag>
      <Tag tone={toneFor(item.status)}>{item.statusLabel}</Tag>
      {item.status === "missed" && <Tag tone="t-red">Missed scheduled time</Tag>}
    </div>
    <h2 className="mt-3 font-display text-lg font-semibold">{item.concept}</h2>
    <p className="mt-1 text-sm text-text-3">{item.dayLabel} · {item.localTime}</p>
    {item.status === "missed" && <p role="alert" className="mt-3 rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-sm text-amber">
      {item.missedReason ?? "Its scheduled time passed without publishing."} Voom never publishes hours late on its own — post it now or reschedule from the Marketing Plan.
    </p>}
    {pastDue && item.status !== "missed" && <p className="mt-3 rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-sm text-amber">
      This item is past its scheduled time. It stays right here until Voom completes it — it is never silently dropped or published twice.
    </p>}
    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-text-2">{item.caption}</p>
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
function colorFor(status: string) {
  if (status === "published") return "#1c8a52";
  if (status === "failed") return "#c0392b";
  if (status === "missed") return "#c0392b";
  if (status === "needs_approval" || status === "ready_for_review") return "#f2a516";
  if (status === "generating" || status === "publishing" || status === "scheduled") return "#2f6f9f";
  return "#e8481f";
}
function toneFor(status: string) {
  if (status === "published") return "t-green";
  if (status === "failed") return "t-red";
  if (status === "missed") return "t-red";
  if (status === "needs_approval" || status === "ready_for_review") return "t-amber";
  if (status === "generating" || status === "publishing" || status === "scheduled") return "t-blue";
  return "t-grey";
}
