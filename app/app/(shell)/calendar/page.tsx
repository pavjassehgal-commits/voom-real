"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { ComposeModal } from "@/components/voom/modals/ComposeModal";
import { CreateContentModal } from "@/components/voom/modals/CreateContentModal";
import { PostDetailModal } from "@/components/voom/modals/PostDetailModal";
import { SavedCalendarDetailModal } from "@/components/voom/modals/SavedCalendarDetailModal";
import { Btn, Card, Chip, IconBtn, Tag } from "@/components/voom/ui/primitives";
import { PublishingQueue } from "@/components/voom/PublishingQueue";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const CHANS = ["All", "Reel", "Story", "Feed", "Email", "SMS"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function CalendarPage() {
  const { calMonth, calYear, calFilter, posts } = useVoomState();
  const { calMove, calToday, setCalFilter, goTo } = useVoomActions();
  const { open } = useModal();
  const [savedItems, setSavedItems] = useState<Array<{ id: string; title: string; channel: string; publish_at: string; status: string; contentType: string | null }>>([]);
  const [calendarError, setCalendarError] = useState<string | null>(null);

  const loadSavedItems = useCallback(async () => {
    const start = new Date(calYear, calMonth, 1).toISOString();
    const end = new Date(calYear, calMonth + 1, 0, 23, 59, 59, 999).toISOString();
    try {
      const response = await fetch(`/api/voom/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { cache: "no-store" });
      const body = await response.json() as { items?: typeof savedItems; error?: string };
      if (!response.ok) throw new Error(body.error || "The saved calendar couldn't load.");
      setSavedItems(body.items ?? []); setCalendarError(null);
    } catch (reason) { setCalendarError(reason instanceof Error ? reason.message : "The saved calendar couldn't load."); }
  }, [calMonth, calYear]);

  useEffect(() => { const timer = window.setTimeout(() => void loadSavedItems(), 0); return () => window.clearTimeout(timer); }, [loadSavedItems]);
  useEffect(() => { const refresh = () => void loadSavedItems(); window.addEventListener("voom:data-changed", refresh); return () => window.removeEventListener("voom:data-changed", refresh); }, [loadSavedItems]);

  const isAug = calMonth === 7 && calYear === 2026;

  const cells = useMemo(() => {
    const first = new Date(calYear, calMonth, 1).getDay();
    const days = new Date(calYear, calMonth + 1, 0).getDate();
    const prev = new Date(calYear, calMonth, 0).getDate();
    const arr: { d: number; out: boolean }[] = [];
    for (let i = first - 1; i >= 0; i--) arr.push({ d: prev - i, out: true });
    for (let d = 1; d <= days; d++) arr.push({ d, out: false });
    while (arr.length % 7) arr.push({ d: arr.length - days - first + 1, out: true });
    return arr;
  }, [calMonth, calYear]);

  function eventsFor(d: number) {
    const demo = isAug ? posts.filter((p) => p.d === d && (calFilter === "All" || p.ch === calFilter)) : [];
    const saved = savedItems.filter((item) => { const date = new Date(item.publish_at); const filter = calFilter === "All" || item.channel === calFilter || (calFilter === "Feed" && item.channel === "Instagram"); return date.getFullYear() === calYear && date.getMonth() === calMonth && date.getDate() === d && filter; });
    return [
      ...demo.map((item) => ({ source: "demo" as const, key: `demo-${posts.indexOf(item)}`, label: item.t.includes("· ") ? item.t.split("· ")[1] : item.t, color: item.c, index: posts.indexOf(item) })),
      ...saved.map((item) => ({ source: "saved" as const, key: item.id, label: item.contentType ? `${item.contentType} · ${item.title}` : item.title, color: item.contentType === "Reel" ? "#7c3aed" : item.contentType === "Instagram Story" ? "#3fb3a6" : item.contentType === "Existing content" ? "#0f766e" : "#e8481f", index: -1 })),
    ];
  }

  const counts = [...posts.map((p) => p.st), ...savedItems.map((item) => item.status === "scheduled" ? "Scheduled" : item.status === "approved" ? "Draft" : "Idea")].reduce<Record<string, number>>((acc, status) => {
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <PageHead
        title="Content calendar"
        description={`${posts.length + savedItems.length} pieces planned · ${counts.Scheduled || 0} scheduled, ${counts.Draft || 0} drafts, ${counts.Idea || 0} ideas`}
        actions={
          <>
            <Btn variant="outline" size="sm" onClick={() => goTo("plan")}>
              <Icon name="spark" size={14} /> Review weekly plan
            </Btn>
            <Btn variant="outline" size="sm" onClick={() => open(<CreateContentModal onChanged={() => void loadSavedItems()} />)}>
              <Icon name="ig" size={14} /> Create content
            </Btn>
            <Btn variant="primary" size="sm" onClick={() => open(<ComposeModal />)}>
              <Icon name="plus" size={14} /> New post
            </Btn>
          </>
        }
      />

      <PublishingQueue />

      {calendarError && <div role="alert" className="mb-3 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{calendarError}</div>}

      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
        <p className="text-[12.5px] leading-relaxed text-text-2">
          <span className="mr-1.5 inline-flex items-center gap-1 rounded-[7px] bg-surface px-2 py-[2px] text-[10.5px] font-bold uppercase tracking-[.06em] text-text-3">Sample</span>
          Events in this sample dataset (Aug 2026) are illustration-only. New posts and MARA-approved items are saved in Voom and stay after refresh.
        </p>
      </div>

      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2">
          <IconBtn onClick={() => calMove(-1)}>
            <Icon name="back" />
          </IconBtn>
          <b className="min-w-[170px] text-center font-display text-lg">
            {MONTHS[calMonth]} {calYear}
          </b>
          <IconBtn onClick={() => calMove(1)}>
            <Icon name="arrow" />
          </IconBtn>
          <Btn variant="ghost" size="sm" onClick={calToday}>
            Today
          </Btn>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CHANS.map((c) => (
            <Chip key={c} active={calFilter === c} onClick={() => setCalFilter(c)}>
              {c}
            </Chip>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-[var(--r)] border border-line bg-line">
        {DOW.map((d) => (
          <div key={d} className="bg-surface-2 py-2.5 text-center text-[11px] font-bold uppercase tracking-[.06em] text-text-3">
            {d}
          </div>
        ))}
        {cells.map((c, i) => {
          const evs = c.out ? [] : eventsFor(c.d);
          const isToday = !c.out && isAug && c.d === 24;
          return (
            <div
              key={i}
              className={`group flex min-h-[74px] cursor-pointer flex-col gap-1 bg-surface p-1.5 transition hover:bg-surface-2 sm:min-h-[118px] sm:p-1.5 ${c.out ? "bg-surface-2 opacity-50" : ""}`}
              onClick={() => !c.out && open(<ComposeModal day={c.d} />)}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`grid h-[23px] w-[23px] place-items-center rounded-lg text-xs font-semibold ${isToday ? "voom-grad text-white" : "text-text-2"}`}
                >
                  {c.d}
                </span>
                {!c.out && (
                  <span className="grid h-[21px] w-[21px] place-items-center rounded-[7px] bg-brand text-[15px] leading-none text-white opacity-0 transition group-hover:opacity-100">
                    +
                  </span>
                )}
              </div>
              {evs.slice(0, 3).map((event) => {
                return (
                  <button
                    type="button"
                    key={event.key}
                    className="flex w-full items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-[7px] px-1.5 py-1 text-left text-[9.5px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand sm:px-2 sm:text-[11px]"
                    style={{ background: `${event.color}1f`, color: event.color }}
                    aria-label={`Open ${event.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (event.source === "demo") open(<PostDetailModal index={event.index} />);
                      else open(<SavedCalendarDetailModal itemId={event.key} />);
                    }}
                  >
                    <i className="hidden h-1.5 w-1.5 flex-none rounded-full sm:inline-block" style={{ background: event.color }} />
                    {event.label}
                  </button>
                );
              })}
              {evs.length > 3 && <span className="pl-1 text-[10px] text-text-3">+{evs.length - 3} more</span>}
            </div>
          );
        })}
      </div>

      <div className="mt-3.5 grid gap-3.5 sm:grid-cols-3">
        {(
          [
            ["Scheduled", "t-green", counts.Scheduled || 0, "Planned inside Voom"],
            ["Draft", "t-amber", counts.Draft || 0, "Waiting on your review"],
            ["Idea", "t-grey", counts.Idea || 0, "Voom suggestions"],
          ] as [string, string, number, string][]
        ).map(([n, t, c, d]) => (
          <Card key={n} className="flex items-center justify-between p-4">
            <div>
              <Tag tone={t}>{n}</Tag>
              <div className="mt-2 font-display text-2xl">{c}</div>
              <span className="text-xs text-text-3">{d}</span>
            </div>
            <IconBtn
              onClick={() => {
                setCalFilter("All");
              }}
            >
              <Icon name="arrow" />
            </IconBtn>
          </Card>
        ))}
      </div>
    </div>
  );
}
