"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/voom/icons";
import { Btn, Card } from "@/components/voom/ui/primitives";
import { replenishPlanDescription } from "@/lib/voom/automation";
import { CADENCES, CADENCE_LABELS, type Cadence } from "@/lib/voom/cadence";
import type { WorkflowSnapshot, WorkflowView } from "@/lib/voom/workflow/read";
import { formatLocalDate, localDate } from "@/lib/voom/timezone";
import {
  PLAN_OUTCOME_COPY,
  PLAN_UP_TO_DATE_LABEL,
  planIsUpToDate,
  planWorkspaceView,
  replenishResponseFeedback,
  rollingWindowLabel,
  type PlanOutcomeFeedback,
  type PlanRunOutcome,
} from "@/lib/voom/workflow/plan-lifecycle";
import { PlanItemCard } from "@/components/voom/operating/PlanItemCard";
// TEMPORARY: planning-only preview control, dev-flag gated. Remove with
// lib/voom/planning-only-preview.ts when the experiment ends.
import { PlanningOnlyPreviewCard } from "@/components/voom/operating/PlanningOnlyPreview";

/**
 * The preview control is a developer/test-only affordance. It stays available
 * for the current controlled workflow testing, but normal production users
 * never see it unless NEXT_PUBLIC_ENABLE_PLANNING_PREVIEW=1 is set.
 */
const SHOW_PLANNING_PREVIEW = process.env.NEXT_PUBLIC_ENABLE_PLANNING_PREVIEW === "1";

/**
 * The Marketing Plan renders the real rolling horizon of executable workflow
 * items — the same items Today, Approvals, the Content Calendar and the
 * publishing queue act on. Each item is ONE complete in-place workflow:
 * produce -> review -> approve -> schedule -> publish (or missed/failed with
 * truthful recovery actions). Changing the posting frequency rebuilds the
 * distribution. Dates come from the account timezone and always begin today.
 *
 * Lifecycle: the primary view is the live window (today → the next 7 days,
 * rolling daily). Every Replenish ends in one explicit, server-reported
 * outcome — added, already up to date, no channels, or failed — and the button
 * reads "✓ Plan up to date" whenever the server's coverage says a Replenish
 * would add nothing. Older or later work that still needs the owner stays
 * reachable below the window; nothing is ever deleted.
 */
export function PlanWorkspace({ initial }: { initial: WorkflowSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [cadence, setCadence] = useState<Cadence>(initial.cadence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The server-reported outcome of the last Replenish, rendered verbatim.
  const [feedback, setFeedback] = useState<PlanOutcomeFeedback | null>(null);
  // AI Media Spend Control: the truthful reason a run left items waiting for
  // media (automatic generation off, or the month's budget reached).
  const [spendNotice, setSpendNotice] = useState("");

  const refresh = useCallback((next: WorkflowSnapshot) => setSnapshot(next), []);
  // Bumped by every Replenish, so a background re-read that started earlier
  // can never overwrite the fresher snapshot a Replenish returned.
  const buildSeq = useRef(0);

  const shownToday = useRef(initial.today);
  useEffect(() => { shownToday.current = snapshot.today; }, [snapshot.today]);

  const reload = useCallback(async () => {
    const seq = buildSeq.current;
    try {
      const response = await fetch("/api/plan", { cache: "no-store" });
      const body = await response.json() as { snapshot?: WorkflowSnapshot };
      if (!response.ok || !body.snapshot || seq !== buildSeq.current) return;
      // A rolled window makes the last Replenish message stale.
      if (body.snapshot.today !== shownToday.current) setFeedback(null);
      setSnapshot(body.snapshot);
    } catch { /* keep the current view; the next read retries */ }
  }, []);

  // The window rolls at local midnight in the account timezone. A cheap local
  // check each minute re-reads the server snapshot once the local date moves
  // past the one on screen (and keeps retrying until the server agrees), and
  // returning to the tab re-reads too — so the cards and "✓ Plan up to date"
  // follow the live horizon, not the moment the page was first opened.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (localDate(new Date(), snapshot.timeZone) !== shownToday.current) void reload();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [snapshot.timeZone, reload]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void reload(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  // Synchronous in-flight gate: `disabled={busy}` only exists after React
  // commits, so a fast double click could otherwise start a second run.
  const inFlight = useRef(false);

  async function build(next: Cadence) {
    if (inFlight.current) return;
    inFlight.current = true;
    buildSeq.current += 1;
    setBusy(true); setError(""); setFeedback(null); setSpendNotice("");
    try {
      const response = await fetch("/api/plan", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cadence: next }),
      });
      const body = await response.json() as { snapshot?: WorkflowSnapshot; error?: string; mediaSpendNotice?: string | null; outcome?: PlanRunOutcome };
      if (body.snapshot) {
        setSnapshot(body.snapshot);
        setCadence(body.snapshot.cadence);
      } else if (response.ok) void reload();
      if (response.ok || body.outcome) window.dispatchEvent(new Event("voom:data-changed"));
      // The outcome is the server's own account of what happened. Success is
      // shown only for a 2xx whose outcome says so; nothing is inferred here.
      const result = replenishResponseFeedback(response.ok, body);
      setFeedback(result.feedback);
      if (result.error) setError(result.error);
      if (response.ok) setSpendNotice(body.mediaSpendNotice ?? "");
    } catch {
      // The result is unknown, so nothing is claimed either way.
      setError("Voom couldn't confirm what happened. Showing your latest plan — please try again.");
      void reload();
    }
    inFlight.current = false;
    setBusy(false);
  }

  // The primary view is the LIVE rolling window; the split is recomputed from
  // every fresh snapshot, so it rolls forward daily with no stored state.
  const view = planWorkspaceView(snapshot);
  const byDay = groupByDay(view.current);
  const mix = mixLine(view.current);
  const upToDate = planIsUpToDate(snapshot);
  const planned = view.current.length > 0 || view.outside.length > 0;

  return <div>
    {snapshot.selectedChannels.length === 0 && feedback?.tone !== "warning" && <p role="status" className="mb-4 rounded-xl border border-amber/35 bg-amber/10 px-4 py-3 text-sm text-amber">
      <b className="block">{PLAN_OUTCOME_COPY.noChannelsTitle}</b>
      {PLAN_OUTCOME_COPY.noChannelsBody}
      <span className="mt-1 block text-[12.5px]">Voom never invents Instagram work. Connection status affects publishing readiness, not planning eligibility. <a href="/app/settings" className="font-semibold underline">Update channel preferences</a> or <a href="/app/connections" className="font-semibold underline">review publishing connections</a>.</span>
    </p>}
    <Card className="mb-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="text-xs text-text-3">Rolling {view.days}-day plan · {snapshot.timeZone.replace("_", " ")} · {rollingWindowLabel(view.start, view.end) || "starts today"}</span>
          <p className="mt-0.5 text-sm font-semibold">{snapshot.planGoal ?? "No goal set yet"}</p>
          {mix && <p className="mt-0.5 text-[12px] text-text-3">{mix}</p>}
        </div>
        {/* "✓ Plan up to date" comes from the server's live-horizon coverage,
            recomputed on every read: once the window rolls onto an uncovered
            date the button returns to "Replenish plan" by itself. It stays
            clickable — a Replenish on a complete horizon is a safe no-op. */}
        <Btn variant="outline" size="sm" disabled={busy} onClick={() => void build(cadence)}
          title={upToDate ? "Every slot in the next 7 days already has a recommendation. Replenishing now adds nothing." : undefined}>
          {busy
            ? <><Icon name="spark" size={14} />Building…</>
            : upToDate
              ? <span className="text-green">{PLAN_UP_TO_DATE_LABEL}</span>
              : <><Icon name="spark" size={14} />{planned ? "Replenish plan" : "Build plan"}</>}
        </Btn>
      </div>
      {/* Truthful per-mode statement of what Replenish does. In Manual it
          creates the plan only — media starts from Create with MARA. */}
      <p className="mt-2 text-[12.5px] text-text-3">{replenishPlanDescription(snapshot.mode)}</p>
      <div className="mt-4">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-3">Posting frequency</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {CADENCES.map((value) => (
            <Btn key={value} size="sm" variant={value === cadence ? "primary" : "outline"} disabled={busy}
              onClick={() => { setCadence(value); void build(value); }}>
              {CADENCE_LABELS[value]}
            </Btn>
          ))}
        </div>
        <p className="mt-2 text-[12.5px] text-text-3">
          Changing this changes how many items Voom keeps ready in the next 7 days. Existing items for a date are reused, never duplicated.
        </p>
      </div>
    </Card>

    {/* TEMPORARY: planning-only preview control — dev-flag gated. */}
    {SHOW_PLANNING_PREVIEW && <PlanningOnlyPreviewCard className="mb-4" />}

    {error && <p role="alert" className="mb-4 rounded-xl border border-red/35 bg-red/10 px-4 py-3 text-sm text-red">{error}</p>}

    {/* The one explicit outcome of the last Replenish, exactly as the server reported it. */}
    {feedback && <OutcomeBanner feedback={feedback} onDismiss={() => setFeedback(null)} />}

    {/* A blocked automatic generation is not an error: the plan and its drafts
        were created, and only the media waits for the owner's decision. */}
    {spendNotice && <p role="status" className="mb-4 rounded-xl border border-amber/35 bg-amber/10 px-4 py-3 text-sm text-amber">{spendNotice}</p>}

    {planned ? <div className="space-y-3">
      {!view.current.length && <Card className="p-5 text-sm text-text-2">
        Nothing is planned for {formatLocalDate(view.start)} → {formatLocalDate(view.end)} yet. {snapshot.selectedChannels.length ? "Replenish to fill the next 7 days." : "Choose a social channel first."}
      </Card>}
      {byDay.map(([day, items]) => <Card key={day} className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line bg-surface-2 px-4 py-2.5">
          <b className="text-sm">{items[0].dayLabel}</b>
          <span className="text-xs text-text-3">{day}</span>
        </div>
        <div className="divide-y divide-line">
          {items.map((item) => <div key={item.draftId} className="p-3 sm:p-4">
            <PlanItemCard item={item} mode={snapshot.mode} timeZone={snapshot.timeZone} onChanged={refresh} />
          </div>)}
        </div>
      </Card>)}
      {view.outside.length > 0 && <OutsideWindow items={view.outside} mode={snapshot.mode} timeZone={snapshot.timeZone} onChanged={refresh} />}
      <p className="text-[12.5px] text-text-3">
        Every card above is the real item Voom will execute — produce, review, approve, schedule and publish it right here. It appears identically in <a href="/app/today" className="font-semibold text-brand hover:underline">Today</a>, <a href="/app/approvals" className="font-semibold text-brand hover:underline">Approvals</a> and the <a href="/app/calendar" className="font-semibold text-brand hover:underline">Content Calendar</a>. Published and past recommendations move off this rolling view but stay in the Content Calendar and Performance — nothing is deleted.
      </p>
    </div> : <Card className="p-7 text-center sm:p-10">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[var(--brand-soft)] text-brand"><Icon name="spark" size={24} /></span>
      <h2 className="mt-4 font-display text-xl font-semibold">Build your rolling marketing plan</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-text-2">
        Voom creates one executable item per slot for the next 7 days, starting today, using your brand, goal and chosen posting frequency.
      </p>
      <p className="mx-auto mt-2 max-w-xl text-[12.5px] leading-relaxed text-text-3">{replenishPlanDescription(snapshot.mode)}</p>
      <Btn className="mt-5" variant="primary" disabled={busy} onClick={() => void build(cadence)}>
        <Icon name="spark" size={15} />{busy ? "Building your plan…" : "Build plan"}
      </Btn>
    </Card>}
  </div>;
}

const OUTCOME_TONES: Record<PlanOutcomeFeedback["tone"], { box: string; icon: string }> = {
  success: { box: "border-green/35 bg-green/10 text-green", icon: "check" },
  info: { box: "border-brand/30 bg-[var(--brand-soft)] text-brand", icon: "check" },
  warning: { box: "border-amber/35 bg-amber/10 text-amber", icon: "warn" },
  error: { box: "border-red/35 bg-red/10 text-red", icon: "warn" },
};

/** Renders one server-reported Replenish outcome. Copy comes from plan-lifecycle.ts. */
function OutcomeBanner({ feedback, onDismiss }: { feedback: PlanOutcomeFeedback; onDismiss: () => void }) {
  const tone = OUTCOME_TONES[feedback.tone];
  return <div role={feedback.tone === "error" ? "alert" : "status"} className={`mb-4 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${tone.box}`}>
    <Icon name={tone.icon} size={16} className="mt-0.5 shrink-0" />
    <div className="min-w-0 flex-1">
      <b className="block">{feedback.title}</b>
      <span className="text-text-2">{feedback.body}</span>
      {feedback.summary && <span className="mt-1 block text-[12.5px] font-semibold text-text-2">{feedback.summary}</span>}
      {feedback.tone === "warning" && <span className="mt-1 block text-[12.5px]"><a href="/app/settings" className="font-semibold underline">Update channel preferences</a></span>}
    </div>
    <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 text-text-3 hover:text-text"><Icon name="x" size={14} /></button>
  </div>;
}

/**
 * Work dated before or after the live window that still needs the owner
 * (missed, failed, held for media, scheduled later). Collapsed by default so
 * the rolling view stays focused, but always reachable and fully actionable.
 */
function OutsideWindow({ items, mode, timeZone, onChanged }: {
  items: WorkflowView[];
  mode: WorkflowSnapshot["mode"];
  timeZone: string;
  onChanged: (next: WorkflowSnapshot) => void;
}) {
  const needsAction = items.some((item) => item.status === "missed" || item.status === "failed"
    || item.status === "waiting_for_media" || item.status === "media_delayed" || item.status === "media_timed_out");
  return <details open={needsAction} className="rounded-[var(--r-lg)] border border-line bg-surface">
    <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
      Outside the next 7 days · {items.length} item{items.length === 1 ? "" : "s"}
      <span className="block text-[12px] font-normal text-text-3">Missed, held or later-scheduled work stays here so you can still post, reschedule or cancel it.</span>
    </summary>
    <div className="divide-y divide-line border-t border-line">
      {items.map((item) => <div key={item.draftId} className="p-3 sm:p-4">
        <p className="mb-2 text-xs text-text-3">{formatLocalDate(item.localDate || item.slotDate)}</p>
        <PlanItemCard item={item} mode={mode} timeZone={timeZone} onChanged={onChanged} />
      </div>)}
    </div>
  </details>;
}

function groupByDay(items: WorkflowView[]): [string, WorkflowView[]][] {
  const map = new Map<string, WorkflowView[]>();
  for (const item of items) {
    const key = item.localDate || item.slotDate;
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Compact native mix line: exactly which selected channel/format owns each slot. */
function mixLine(items: WorkflowView[]): string | null {
  if (!items.length) return null;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.contentTypeLabel, (counts.get(item.contentTypeLabel) ?? 0) + 1);
  return `Next 7 days: ${[...counts.entries()].map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`).join(" · ")}`;
}
