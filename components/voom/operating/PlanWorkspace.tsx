"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/voom/icons";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";
import { CADENCES, CADENCE_LABELS, type Cadence } from "@/lib/voom/cadence";
import type { WorkflowSnapshot, WorkflowView } from "@/lib/voom/workflow/read";
// TEMPORARY: planning-only preview control. Remove with lib/voom/planning-only-preview.ts.
import { PlanningOnlyPreviewCard } from "@/components/voom/operating/PlanningOnlyPreview";

/**
 * The Marketing Plan renders the real rolling horizon of executable workflow
 * items — the same items Today, Approvals, the Content Calendar and the
 * publishing queue act on. Changing the posting frequency rebuilds the
 * distribution. Dates come from the account timezone and always begin today.
 */
export function PlanWorkspace({ initial }: { initial: WorkflowSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [cadence, setCadence] = useState<Cadence>(initial.cadence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  return <div>
    <Card className="mb-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="text-xs text-text-3">Rolling 7-day plan · {snapshot.timeZone.replace("_", " ")} · starts {snapshot.today}</span>
          <p className="mt-0.5 text-sm font-semibold">{snapshot.planGoal ?? "No goal set yet"}</p>
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

    {/* TEMPORARY: planning-only preview control — delete this line to remove it. */}
    <PlanningOnlyPreviewCard className="mb-4" />

    {error && <p role="alert" className="mb-4 rounded-xl border border-red/35 bg-red/10 px-4 py-3 text-sm text-red">{error}</p>}

    {snapshot.items.length ? <div className="space-y-3">
      {byDay.map(([day, items]) => <Card key={day} className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line bg-surface-2 px-4 py-2.5">
          <b className="text-sm">{items[0].dayLabel}</b>
          <span className="text-xs text-text-3">{day}</span>
        </div>
        {items.map((item) => <div key={item.draftId} className="grid gap-2 border-t border-line px-4 py-3.5 first:border-0 md:grid-cols-[110px_130px_1fr_140px]">
          <span className="text-sm font-semibold">{item.localTime}</span>
          <Tag tone="t-blue" className="self-start justify-self-start">{item.contentTypeLabel}</Tag>
          <div className="min-w-0">
            <b className="text-sm">{item.concept}</b>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-text-2">{item.caption}</p>
          </div>
          <Tag tone={tone(item.status)} className="self-start justify-self-start">{item.statusLabel}</Tag>
        </div>)}
      </Card>)}
      <p className="text-[12.5px] text-text-3">
        These are the actual items Voom will execute. Approve them in <Link href="/app/approvals" className="font-semibold text-brand hover:underline">Approvals</Link> or
        watch them in the <Link href="/app/calendar" className="font-semibold text-brand hover:underline">Content Calendar</Link>.
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

function tone(status: string) {
  if (status === "published") return "t-green";
  if (status === "failed") return "t-red";
  if (status === "needs_approval") return "t-amber";
  if (status === "generating" || status === "publishing") return "t-blue";
  return "t-grey";
}
