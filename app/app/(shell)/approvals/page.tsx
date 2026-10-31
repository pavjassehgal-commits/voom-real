import { ApprovalsWorkspace } from "@/components/voom/operating/ApprovalsWorkspace";
import type { ApprovalDraftFacts, ApprovalItem } from "@/components/voom/operating/ApprovalsBoard";
import { getOperatingData } from "@/lib/voom/operating-data";

export const dynamic = "force-dynamic";

/**
 * Approvals is a thin loader over the existing authoritative feed:
 * `getOperatingData()` already filters the owner's `mara_pending_actions` to the
 * current workflow horizon. Each card's draft facts (media, status) come from
 * the SAME shared workflow snapshot Today and the Marketing Plan read.
 */
export default async function ApprovalsPage() {
  const data = await getOperatingData();
  if (!data) return null;

  const drafts: Record<string, ApprovalDraftFacts> = {};
  for (const item of data.snapshot.items) {
    drafts[item.draftId] = {
      draftId: item.draftId,
      channel: item.channel,
      channelLabel: item.channelLabel,
      contentTypeLabel: item.contentTypeLabel,
      status: item.status,
      statusLabel: item.statusLabel,
      hasMedia: item.hasMedia,
      mediaPreviewUrl: item.mediaPreviewUrl,
      mediaMimeType: item.mediaMimeType,
    };
  }
  const scheduled = data.snapshot.items
    .filter((item) => ["scheduled", "publishing", "published"].includes(item.status))
    .sort((a, b) => a.publishAt.localeCompare(b.publishAt));
  const upcoming = scheduled.find((item) => item.status !== "published");

  return <ApprovalsWorkspace
    initial={data.actions as ApprovalItem[]}
    reelTaskCount={data.reelTaskCount}
    drafts={drafts}
    publishesThisWeek={{ count: scheduled.length, next: upcoming ? `${upcoming.concept} · ${upcoming.dayLabel} ${upcoming.localTime}` : null }}
  />;
}
