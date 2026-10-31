"use client";

import { ApprovalsBoard, type ApprovalDraftFacts, type ApprovalItem } from "@/components/voom/operating/ApprovalsBoard";
import { PageHeader, StatCard } from "@/components/voom/redesign/ui";

/**
 * Approvals (Figma "Review what needs your decision", drawn on PDF p.76).
 *
 * One client surface over the existing authoritative feed so the header's
 * counts and the queue's cards can never disagree — both are derived from the
 * SAME `initial` array (`getOperatingData().actions`, already narrowed to the
 * current workflow horizon). `drafts` carries the workflow facts (media,
 * status) of each card's draft from the same shared snapshot.
 *
 * Nothing here publishes, sends, spends or changes Autopilot behaviour: every
 * decision is the existing `/api/mara/actions/{id}` call.
 */
export function ApprovalsWorkspace({ initial, reelTaskCount = 0, drafts = {}, publishesThisWeek = null }: {
  initial: ApprovalItem[];
  reelTaskCount?: number;
  drafts?: Record<string, ApprovalDraftFacts>;
  publishesThisWeek?: { count: number; next: string | null } | null;
}) {
  const pending = initial.filter((item) => item.status === "pending");
  const waiting = pending.length;
  const retryable = initial.filter((item) => item.status === "failed").length;
  const open = waiting + retryable;
  const oldest = pending.map((item) => item.created_at).sort()[0] ?? null;

  return (
    <div className="min-w-0">
      <PageHeader
        title="Review what needs your decision."
        subtitle={open === 0
          ? "You’re all caught up. Voom has nothing waiting on you."
          : `${open} thing${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} your decision. Approve, edit or cancel before it’s scheduled — nothing here publishes on its own.`}
      />
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard icon="clock" value={waiting} label="Waiting on you" tone="coral" note={oldest ? <span className="font-normal text-text-2">Oldest submitted {ago(oldest)}</span> : undefined} />
        <StatCard icon="cal" value={publishesThisWeek?.count ?? "—"} label="Publishes this week" tone="brand" note={publishesThisWeek?.next ? <span className="font-normal text-text-2">Next: {publishesThisWeek.next}</span> : undefined} />
        <StatCard icon="warn" value={retryable} label="Retry needed" tone={retryable ? "coral" : "green"} note={reelTaskCount > 0 ? <span className="font-normal text-text-2">{reelTaskCount} Reel production choice{reelTaskCount === 1 ? "" : "s"}</span> : undefined} />
      </div>
      <ApprovalsBoard initial={initial} drafts={drafts} />
    </div>
  );
}

function ago(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "recently";
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hours ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}
