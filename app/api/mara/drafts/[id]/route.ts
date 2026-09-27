import { getBusinessRecord, getCurrentUser, getProfileRecord } from "@/lib/voom/server-data";
import { executeMaraTool } from "@/lib/mara/tools";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * LEGACY — retained deliberately, not dead.
 *
 * No in-app surface calls this route any more (the MARA chat loop was retired;
 * drafts are reviewed on Approvals through /api/mara/actions/[id] and the
 * posts / social-drafts routes). It is kept because:
 *   1. it is an authenticated, owner-scoped HTTP endpoint that still behaves
 *      correctly — approval here only creates a pending action that the owner
 *      must confirm; nothing is published;
 *   2. it is the ONLY remaining entry point into `executeMaraTool`, and
 *      tests/mara-security.test.mjs ("approval cannot publish content") pins
 *      that exact contract by reading this file.
 * Removing it is a separate decision that must move that regression guard
 * onto another surface first.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "Invalid draft." }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid draft update." }, { status: 400 });
  }

  const supabase = await createClient();
  // Writes go through the owner-filtered service-role client: authenticated
  // users have no direct write access to drafts or approvals (migration 0050).
  const admin = createAdminClient();
  if (body.action === "approve") {
    const [{ data: draft }, business, profile] = await Promise.all([
      supabase.from("mara_drafts").select("conversation_id,message_id").eq("id", id).eq("owner_user_id", user.id).maybeSingle(),
      getBusinessRecord(), getProfileRecord(),
    ]);
    if (!draft || !business) return Response.json({ error: "Draft not found." }, { status: 404 });
    const result = await executeMaraTool({ db: admin, ownerId: user.id, conversationId: draft.conversation_id, business, profile }, "approve_draft", JSON.stringify({ draftId: id }));
    if (!result.ok || !result.pendingActionId) return Response.json({ error: result.summary }, { status: 503 });
    if (draft.message_id) await admin.from("mara_pending_actions").update({ message_id: draft.message_id }).eq("id", result.pendingActionId).eq("owner_user_id", user.id);
    const { data: pendingAction } = await supabase.from("mara_pending_actions").select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").eq("id", result.pendingActionId).eq("owner_user_id", user.id).single();
    return Response.json({ pendingAction, message: "Review and confirm the approval. Nothing has changed yet." });
  }

  const update: Record<string, string | null> = {};
  if (body.action === "reject") update.status = "rejected";
  else if (body.action === "edit") {
    if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 12000) {
      return Response.json({ error: "Draft content must be between 1 and 12,000 characters." }, { status: 400 });
    }
    update.content = body.content.trim();
    if (body.proposedPublishAt === null) update.proposed_publish_at = null;
    else if (typeof body.proposedPublishAt === "string" && !Number.isNaN(Date.parse(body.proposedPublishAt))) {
      update.proposed_publish_at = new Date(body.proposedPublishAt).toISOString();
    }
  } else return Response.json({ error: "Unknown draft action." }, { status: 400 });

  const { data, error } = await admin
    .from("mara_drafts")
    .update(update)
    .eq("id", id)
    .eq("owner_user_id", user.id)
    .select("id,conversation_id,message_id,kind,channel,title,content,proposed_publish_at,status,created_at,updated_at")
    .maybeSingle();
  if (error) return Response.json({ error: "We couldn't update that draft. Please retry." }, { status: 503 });
  if (!data) return Response.json({ error: "Draft not found." }, { status: 404 });
  return Response.json({ draft: data });
}
