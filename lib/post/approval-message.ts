import "server-only";
import type { AdminClient, PostView } from "./server-data";
import { getInstagramConnection } from "@/lib/instagram/data";
import { instagramPublishReadiness } from "@/lib/instagram/publish-readiness";

/** A saved approval or calendar mirror is not proof of a publishing job. */
export async function postApprovalMessage(admin: AdminClient, ownerId: string, post: PostView, now: Date = new Date()): Promise<string> {
  if (post.status !== "approved") return "This content is not currently approved. Review the latest version and approve it again before scheduling.";
  const [connection, queue] = await Promise.all([
    getInstagramConnection(admin, ownerId, true),
    admin.from("instagram_publish_queue").select("status")
      .eq("owner_user_id", ownerId).eq("draft_id", post.id).maybeSingle(),
  ]);
  if (queue.error) return "Approved inside Voom, but the publishing job could not be verified. Refresh before scheduling again.";
  if (queue.data?.status === "published") return "Already published. No second post was queued.";
  if (queue.data?.status === "publishing") return "The existing publishing job is already in progress. No second post was queued.";
  const readiness = instagramPublishReadiness(connection, now);
  if (readiness === "expired") return "Approved inside Voom, but Instagram authorization has expired. Reconnect Instagram before publishing. Your approval and any existing publishing job are unchanged; review the job's status and time after reconnecting.";
  if (!post.visualReady) return "Approved inside Voom. Generate or upload the missing media, review it and approve again before scheduling.";
  if (readiness !== "ready") return "Approved inside Voom, but publishing is blocked. Check the proposed time. Connect Instagram with publishing permission.";
  if (queue.data?.status === "scheduled") return "Approved and scheduled in the publishing queue. Nothing was published by this action.";
  return "Approved inside Voom, but not scheduled. Choose a valid future time and schedule this post explicitly.";
}
