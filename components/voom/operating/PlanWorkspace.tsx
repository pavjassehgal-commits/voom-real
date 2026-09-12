"use client";

import { useCallback, useState } from "react";
import { Icon } from "@/components/voom/icons";
import { Btn, Card } from "@/components/voom/ui/primitives";
import { CADENCES, CADENCE_LABELS, type Cadence } from "@/lib/voom/cadence";
import type { WorkflowSnapshot, WorkflowView } from "@/lib/voom/workflow/read";
import { formatLocalDate } from "@/lib/voom/timezone";
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
 */
export function PlanWorkspace({ initial }: { initial: WorkflowSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [cadence, setCadence] = useState<Cadence>(initial.cadence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback((next: WorkflowSnapshot) => setSnapshot(next), []);

  async function build(next: Cadence) {
    setBusy(true); setError("");
    const response = await fetch("/api/plan", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cadence: next }),
    });
    const body = await response.json() as { snapshot?: WorkflowSnapshot; error?: string };
    if (response.ok && body.snapshot) {
      setSnapshot(body.snapshot);
      setCadence(body.snapshot.cadence);
      window.dispatchEvent(new Event("voom:data-changed"));
    } else setError(body.error ?? "Voom couldn't build your plan right now.");
    setBusy(false);
  }

  const byDay = groupByDay(snapshot.items);
  const mix = mixLine(snapshot.items);

  return <div>
    <Card className="mb-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="text-xs text-text-3">Rolling 7-day plan · {snapshot.timeZone.replace("_", " ")} · starts {formatLocalDate(snapshot.today)}</span>
          <p className="mt-0.5 text-sm font-semibold">{snapshot.planGoal ?? "No goal set yet"}</p>
          {mix && <p className="mt-0.5 text-[12px] text-text-3">{mix}</p>}
        </div>
        <Btn variant="outline" size="sm" disabled={busy} onClick={() => void build(cadence)}>
          <Icon name="spark" size={14} />{busy ? "Building…" : snapshot.items.length ? "Replenish plan" : "Build plan"}
        </Btn>
      </div>
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

    {snapshot.items.length ? <div className="space-y-3">
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
      <p className="text-[12.5px] text-text-3">
        Every card above is the real item Voom will execute — produce, review, approve, schedule and publish it right here. It appears identically in <a href="/app/today" className="font-semibold text-brand hover:underline">Today</a>, <a href="/app/approvals" className="font-semibold text-brand hover:underline">Approvals</a> and the <a href="/app/calendar" className="font-semibold text-brand hover:underline">Content Calendar</a>.
      </p>
    </div> : <Card className="p-7 text-center sm:p-10">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[var(--brand-soft)] text-brand"><Icon name="spark" size={24} /></span>
      <h2 className="mt-4 font-display text-xl font-semibold">Build your rolling marketing plan</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-text-2">
        Voom creates one executable item per slot for the next 7 days, starting today, using your brand, goal and chosen posting frequency.
      </p>
      <Btn className="mt-5" variant="primary" disabled={busy} onClick={() => void build(cadence)}>
        <Icon name="spark" size={15} />{busy ? "Building your plan…" : "Build plan"}
      </Btn>
    </Card>}
  </div>;
}

function groupByDay(items: WorkflowView[]): [string, WorkflowView[]][] {
  const map = new Map<string, WorkflowView[]>();
  for (const item of items) {
    const key = item.localDate || item.slotDate;
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Compact strategic-mix line: what the horizon actually contains. */
function mixLine(items: WorkflowView[]): string | null {
  if (!items.length) return null;
  const counts = { post: 0, reel: 0, story: 0 } as Record<string, number>;
  for (const item of items) counts[item.contentType] += 1;
  const parts: string[] = [];
  if (counts.post) parts.push(`${counts.post} post${counts.post === 1 ? "" : "s"}`);
  if (counts.reel) parts.push(`${counts.reel} reel${counts.reel === 1 ? "" : "s"}`);
  if (counts.story) parts.push(`${counts.story} stor${counts.story === 1 ? "y" : "ies"}`);
  return `This week's mix: ${parts.join(" · ")}`;
}
