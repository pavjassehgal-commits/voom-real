import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LinkedInClient } from "./client.ts";
import type { LinkedInConfig } from "./config.ts";
import { oneShotInput, UUID } from "./http.ts";
import { publishClaimedLinkedInJob } from "./publish-worker.ts";

export async function runLinkedInOneShot(ownerId: string, draftId: string, input: unknown, deps: {
  db: SupabaseClient; config: LinkedInConfig; client?: Pick<LinkedInClient,"publishText">;
}): Promise<string> {
  const parsed = oneShotInput.safeParse(input);
  if (!UUID.safeParse(ownerId).success || !UUID.safeParse(draftId).success || !parsed.success) return "not_claimed";
  const consent = parsed.data;
  const { data: job, error } = await deps.db.from("linkedin_publish_queue")
    .select("id,owner_user_id,draft_id,connection_id,member_sub,caption,approved_content_version,status,attempts,scheduled_at,next_attempt_at")
    .eq("owner_user_id", ownerId).eq("draft_id", draftId).eq("id", consent.queueId).maybeSingle();
  if (error) throw new Error("linkedin_single_read_failed");
  const now = new Date().toISOString();
  if (!job || job.status !== "scheduled" || job.connection_id !== consent.connectionId || job.member_sub !== consent.memberSub
    || Number(job.approved_content_version) !== consent.version || job.attempts >= 5
    || !(Date.parse(job.scheduled_at) <= Date.parse(now)) || !(Date.parse(job.next_attempt_at) <= Date.parse(now))) return "not_claimed";
  const { data: draft, error: draftError } = await deps.db.from("mara_drafts")
    .select("status,kind,approval_origin,content_version,approved_content_version,content,proposed_publish_at")
    .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
  if (draftError) throw new Error("linkedin_single_read_failed");
  if (!draft || draft.kind !== "linkedin_text" || draft.status !== "approved" || draft.approval_origin !== "user"
    || Number(draft.content_version) !== consent.version || Number(draft.approved_content_version) !== consent.version
    || draft.content !== job.caption || Date.parse(draft.proposed_publish_at) !== Date.parse(job.scheduled_at)) return "not_claimed";

  // A single conditional UPDATE is the claim. It cannot select another job,
  // sweep stale leases, or race another claimant into a duplicate submission.
  const { data: claimed, error: claimError } = await deps.db.from("linkedin_publish_queue")
    .update({ status: "claimed", claim_token: randomUUID(), claimed_at: now, updated_at: now, attempts: job.attempts + 1 })
    .eq("id", job.id).eq("owner_user_id", ownerId).eq("draft_id", draftId).eq("status", "scheduled")
    .eq("attempts", job.attempts).eq("approved_content_version", consent.version)
    .eq("connection_id", consent.connectionId).eq("member_sub", consent.memberSub)
    .eq("scheduled_at", job.scheduled_at).eq("next_attempt_at", job.next_attempt_at)
    .lte("scheduled_at", now).lte("next_attempt_at", now).lt("attempts", 5)
    .select("id,owner_user_id,draft_id,connection_id,member_sub,caption,claim_token").maybeSingle();
  if (claimError) throw new Error("linkedin_single_claim_unconfirmed");
  if (!claimed) return "not_claimed";
  if (claimed.id !== job.id || claimed.owner_user_id !== ownerId || claimed.draft_id !== draftId
    || claimed.connection_id !== consent.connectionId || claimed.member_sub !== consent.memberSub) throw new Error("linkedin_single_claim_invalid");
  // Reuse the encrypted vault, final SQL approval/account gate and result writer.
  // Neither this path nor its per-job flow invokes the global batch claimant.
  return publishClaimedLinkedInJob(deps.db, deps.config, deps.client ?? new LinkedInClient(deps.config), claimed);
}
