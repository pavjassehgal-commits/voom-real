import { getCurrentUser } from "@/lib/voom/server-data";
import { loadWorkflowSnapshot } from "@/lib/voom/workflow/read";
import { listSocialCalendarItems } from "@/lib/social/server-drafts";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/**
 * Owner-scoped read of the ONE executable content workflow. Today, the
 * Marketing Plan and the Content Calendar all render this payload, so no
 * screen can invent content or dates of its own.
 *
 * Multi-Social Core: `socialItems` carries the approved + scheduled TikTok and
 * YouTube planning drafts so the ONE calendar is chronological across every
 * channel. The Instagram `snapshot` is untouched, and social items are read
 * only — no provider execution exists for them.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  try {
    const admin = createAdminClient();
    const [snapshot, socialItems] = await Promise.all([
      loadWorkflowSnapshot(admin, user.id),
      listSocialCalendarItems(admin, user.id),
    ]);
    return Response.json({ snapshot, socialItems }, { headers: { "Cache-Control": "no-store" } });
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
