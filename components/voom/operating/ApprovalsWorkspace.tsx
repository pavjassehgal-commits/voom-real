"use client";

import { Icon } from "@/components/voom/icons";
import { ApprovalsBoard, type ApprovalItem } from "@/components/voom/operating/ApprovalsBoard";
import { MetaChip, WorkspaceFrame, WorkspaceHeader } from "@/components/voom/workspace/ui";

/**
 * Approvals answers exactly one question: what actually needs my decision?
 *
 * The surface is one client component over the existing authoritative feed so
 * the header's counts and the board's cards can never disagree — both are
 * derived from the SAME `initial` array:
 *
 *   - `initial` is `getOperatingData().actions`, already narrowed to the current
 *     workflow horizon by the existing server read. This surface never invents
 *     a need, never shows a stale card and never counts anything twice.
 *   - `reelTaskCount` is the existing Reel production task count from the same
 *     read; it is only mentioned when it is greater than zero.
 *
 * Nothing here publishes, sends, spends or changes Autopilot behaviour: every
 * decision is the existing `/api/mara/actions/{id}` call the board always made.
 */
export function ApprovalsWorkspace({ initial, reelTaskCount = 0 }: { initial: ApprovalItem[]; reelTaskCount?: number }) {
  const waiting = initial.filter((item) => item.status === "pending").length;
  const retryable = initial.filter((item) => item.status === "failed").length;
  const open = waiting + retryable;

  return (
    <WorkspaceFrame>
      <WorkspaceHeader
        eyebrow="Approvals"
        title="What actually needs my decision?"
        question={open === 0
          ? "You’re all caught up. Voom has nothing waiting on you."
          : `${open} thing${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} your decision — everything else is already handled.`}
        description="Content preview, channel, scheduled time and Voom's reason for asking — then confirm, edit or cancel. Nothing here publishes, sends or spends on its own."
        meta={<>
          {waiting > 0 && <MetaChip accent><Icon name="bell" size={12} /> {waiting} waiting for you</MetaChip>}
          {retryable > 0 && <MetaChip><span className="text-[var(--red)]">{retryable} need{retryable === 1 ? "s" : ""} a retry</span></MetaChip>}
          {open === 0 && <MetaChip><span className="text-[var(--green)]">Nothing pending</span></MetaChip>}
          {reelTaskCount > 0 && <MetaChip>{reelTaskCount} Reel production choice{reelTaskCount === 1 ? "" : "s"}</MetaChip>}
        </>}
      />
      <ApprovalsBoard initial={initial} />
    </WorkspaceFrame>
  );
}
