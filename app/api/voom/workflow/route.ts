import { getCurrentUser } from "@/lib/voom/server-data";
import { loadScheduledPosts } from "@/lib/voom/today-schedule";
import { loadApprovalFeed } from "@/lib/voom/approval-feed";
import { filterApprovalActionsForCurrentWorkflow, loadWorkflowSnapshot } from "@/lib/voom/workflow/read";
import { listSocialCalendarItems } from "@/lib/social/server-drafts";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/** Owner-scoped calendar, Studio and shell projections of the workflow. */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  try {
    const admin = createAdminClient();
    const scope = new URL(request.url).searchParams.get("view");
    const [snapshot, socialItems, actions] = await Promise.all([
      loadWorkflowSnapshot(admin, user.id),
      scope === "badges" ? [] : listSocialCalendarItems(admin, user.id),
      scope === "badges" ? loadApprovalFeed(admin, user.id, true) : null,
    ]);
    const scheduledPosts = scope === "calendar" ? await loadScheduledPosts(admin, user.id, snapshot.timeZone, new Date()) : undefined;
    const pendingApprovalCount = actions && filterApprovalActionsForCurrentWorkflow(actions, snapshot).length;
    return Response.json({ snapshot, socialItems, pendingApprovalCount, scheduledPosts }, { headers: { "Cache-Control": "no-store" } });
  } catch (reason) {
    const code = reason instanceof Error ? reason.message : "";
    if (code.endsWith("publish_queue_read_failed")) {
      const channel = code.startsWith("youtube_") ? "YouTube" : "TikTok";
      return Response.json({
        error: `Voom couldn't confirm the durable ${channel} queue state. Its items are not being assumed scheduled or published; refresh to retry.`,
      }, { status: 503 });
    }
    if (code.startsWith("social_calendar_")) {
      return Response.json({ error: "Voom couldn't load the native-channel calendar details. No queue status or publication is being assumed; refresh to retry." }, { status: 503 });
    }
    return Response.json({ error: "Your schedule couldn't load. Please retry." }, { status: 503 });
  }
}
