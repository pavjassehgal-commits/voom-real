import { listYouTubePublishQueue } from "@/lib/youtube/publish-queue";
import { YOUTUBE_PUBLISH_STATE_LABELS, youTubePublishStatusTone, type YouTubePublishState } from "@/lib/youtube/publishing";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/**
 * The owner's YouTube publish queue — sanitized for presentation.
 *
 * Truthfulness rules:
 *   - statuses are the durable queue's own; nothing is smoothed over. An
 *     item is only `published` when YouTube returned a real video id AND its
 *     own uploadStatus='processed' (the database enforces this).
 *   - the privacy shown is the privacy YOUTUBE ACTUALLY APPLIED
 *     (provider_privacy_status), with the requested one alongside — so an
 *     unaudited-project private lock is visible, never hidden.
 *   - no token, session URL or internal column leaves the server.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  try {
    const rows = await listYouTubePublishQueue(createAdminClient(), user.id, 100);
    return Response.json({
      items: rows.map((row) => ({
        id: row.id,
        draftId: row.draft_id,
        format: row.youtube_format,
        title: row.title,
        status: row.status,
        statusLabel: YOUTUBE_PUBLISH_STATE_LABELS[row.status as YouTubePublishState] ?? row.status,
        statusTone: youTubePublishStatusTone(row.status),
        scheduledAt: row.scheduled_at,
        requestedPrivacy: row.privacy_status,
        providerPrivacy: row.provider_privacy_status,
        madeForKids: row.made_for_kids,
        videoId: row.youtube_video_id,
        providerNote: row.provider_note,
        failureCode: row.failure_code,
        failureMessage: row.failure_message,
        publishedAt: row.published_at,
        attempts: row.attempts,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The YouTube queue is temporarily unavailable." }, { status: 503 });
  }
}
