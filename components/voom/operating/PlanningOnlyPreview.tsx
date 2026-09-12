"use client";

/**
 * TEMPORARY — "Preview 7-Day Plan (No Media)" control for the Marketing Plan.
 *
 * One button, one read-out, no coupling to the rest of the plan workspace: it
 * calls the existing authenticated `POST /api/plan` with exactly
 * `{ "stage": "planning_only" }` and renders the summary that comes back. It
 * never touches the normal "Replenish plan" / cadence handler, never sends an
 * owner id, and never starts media generation, approval, calendar scheduling,
 * the Instagram queue or publishing.
 *
 * Remove together with lib/voom/planning-only-preview.ts, the one line in
 * PlanWorkspace.tsx that renders it, and its test.
 */

import { useState } from "react";
import { Icon } from "@/components/voom/icons";
import { Btn, Card, StatMini, Tag } from "@/components/voom/ui/primitives";
import {
  planningPreviewSummary,
  PLANNING_ONLY_BODY,
  PLANNING_ONLY_ENDPOINT,
  requestPlanningOnlyPreview,
  type PlanningPreviewRun,
  type PlanningPreviewSummary,
} from "@/lib/voom/planning-only-preview";

export const PLANNING_ONLY_PREVIEW_LABEL = "Preview 7-Day Plan (No Media)";

export function PlanningOnlyPreviewCard({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<PlanningPreviewRun | null>(null);

  // The preview action: one request, the planning-only stage, nothing else.
  async function previewPlan() {
    setBusy(true);
    setError("");
    try {
      setRun(await requestPlanningOnlyPreview());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't preview your plan right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={className ? `p-4 sm:p-5 ${className}` : "p-4 sm:p-5"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <b className="text-sm">Planning preview — temporary test control</b>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-3">
            Runs the real 7-day planner for your signed-in account only: {PLANNING_ONLY_ENDPOINT} with{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5 text-[12px]">{PLANNING_ONLY_BODY}</code>. No media, no approvals, no
            calendar scheduling, no Instagram queue, no publishing.
          </p>
        </div>
        <Btn variant="outline" size="sm" disabled={busy} onClick={() => void previewPlan()}>
          <Icon name="eye" size={14} />{busy ? "Previewing…" : PLANNING_ONLY_PREVIEW_LABEL}
        </Btn>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-xl border border-red/35 bg-red/10 px-4 py-3 text-sm text-red">
          {error}
        </p>
      )}

      {run && (
        <div className="mt-4 border-t border-line pt-4">
          <PlanningPreviewReadout summary={planningPreviewSummary(run)} />
        </div>
      )}
    </Card>
  );
}

/** The read-out: counts, cadence, timezone and every planned slot. */
export function PlanningPreviewReadout({ summary }: { summary: PlanningPreviewSummary }) {
  return <div>
    <div className="grid grid-cols-3 gap-2">
      <StatMini value={String(summary.created)} label="Created" />
      <StatMini value={String(summary.reused)} label="Reused" />
      <StatMini value={String(summary.totalItems)} label={`Items · ${summary.horizonDays} days`} />
    </div>

    <p className="mt-3 text-[12.5px] text-text-2">
      <b>{summary.cadenceLabel}</b> · {summary.timeZone.replace(/_/g, " ")} · {summary.validFrom} → {summary.validUntil}
    </p>

    <div className="mt-3 space-y-1.5">
      {summary.slots.map((slot) => (
        <div key={slot.slot} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-2 text-[13px]">
          <b className="w-[96px] font-semibold">{slot.localDate}</b>
          <span className="w-[72px] text-text-2">{slot.localTime}</span>
          <Tag tone="t-blue">{slot.contentTypeLabel}</Tag>
          <Tag tone={slot.created ? "t-brand" : "t-grey"}>{slot.created ? "New" : "Reused"}</Tag>
        </div>
      ))}
    </div>

    <p className="mt-3 text-[12.5px] leading-relaxed text-text-3">
      Planning only: {summary.mediaQueued} media jobs, {summary.autoApproved} auto-approved, {summary.awaitingApproval} awaiting
      approval, {summary.heldForReview} held for review. Nothing was generated, approved, scheduled, queued or published.
    </p>
  </div>;
}
