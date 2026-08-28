import { getCurrentUser } from "@/lib/voom/server-data";
import { executeConfirmedAction } from "@/lib/mara/tools";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That action is not valid." }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That action is not valid." }, { status: 400 }); }
  const decision = body && typeof body === "object" && "decision" in body ? (body as { decision?: unknown }).decision : null;
  if (decision !== "confirm" && decision !== "cancel" && decision !== "edit") return Response.json({ error: "Choose Confirm, Edit, or Cancel." }, { status: 400 });
  const db = await createClient();

  if (decision === "edit") {
    const changes = body && typeof body === "object" && "changes" in body ? (body as { changes?: unknown }).changes : null;
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) return Response.json({ error: "Those changes are not valid." }, { status: 400 });
    const allowed = new Set(["title", "channel", "content", "topic", "publishAt", "proposedPublishAt", "name", "objective", "audience", "subject", "previewText", "proposedSendAt", "budget"]);
    const clean = Object.fromEntries(Object.entries(changes as Record<string, unknown>).filter(([key, value]) => allowed.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)));
    if (!Object.keys(clean).length || JSON.stringify(clean).length > 14000) return Response.json({ error: "Those changes are not valid." }, { status: 400 });
    const { data: current } = await db.from("mara_pending_actions").select("sanitized_arguments,new_value").eq("id", id).eq("owner_user_id", user.id).in("status", ["pending", "failed"]).maybeSingle();
    if (!current) return currentAction(db, user.id, id);
    const nextArguments = { ...(current.sanitized_arguments ?? {}), ...clean };
    const { data, error } = await db.from("mara_pending_actions").update({ sanitized_arguments: nextArguments, new_value: { ...(current.new_value ?? {}), ...clean }, status: "pending", error_summary: null, result_summary: "Updated proposal. Review it before confirming." }).eq("id", id).eq("owner_user_id", user.id).in("status", ["pending", "failed"]).select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").single();
    if (error) return friendlyFailure();
    await db.from("mara_tool_runs").update({ sanitized_arguments: nextArguments, status: "pending_confirmation", error_summary: null, result_summary: "Proposal edited by the user and awaiting confirmation." }).eq("pending_action_id", id).eq("owner_user_id", user.id);
    return Response.json({ action: data, message: "Proposal updated. Nothing has been applied yet." });
  }

  if (decision === "cancel") {
    const { data, error } = await db.from("mara_pending_actions").update({ status: "cancelled", result_summary: "Cancelled. Nothing changed.", executed_at: new Date().toISOString() })
      .eq("id", id).eq("owner_user_id", user.id).eq("status", "pending")
      .select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").maybeSingle();
    if (error) return friendlyFailure();
    if (!data) return currentAction(db, user.id, id);
    await db.from("mara_tool_runs").update({ status: "rejected", result_summary: "Cancelled by the user. Nothing changed.", completed_at: new Date().toISOString() }).eq("pending_action_id", id).eq("owner_user_id", user.id);
    return Response.json({ action: data, message: "Cancelled. Nothing changed." });
  }

  const { data: claimed, error: claimError } = await db.from("mara_pending_actions").update({ status: "executing", error_summary: null })
    .eq("id", id).eq("owner_user_id", user.id).in("status", ["pending", "failed"])
    .select("id,conversation_id,tool_name,sanitized_arguments,status").maybeSingle();
  if (claimError) return friendlyFailure();
  if (!claimed) return currentAction(db, user.id, id);
  try {
    const result = await executeConfirmedAction({ db, ownerId: user.id, conversationId: claimed.conversation_id }, claimed);
    await db.from("mara_tool_runs").update({ status: "succeeded", result_summary: result.summary.slice(0, 1000), completed_at: new Date().toISOString() }).eq("pending_action_id", id).eq("owner_user_id", user.id);
    const { data } = await db.from("mara_pending_actions").select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").eq("id", id).eq("owner_user_id", user.id).single();
    return Response.json({ action: data, message: result.summary });
  } catch {
    await db.from("mara_pending_actions").update({ status: "failed", error_summary: "Voom could not apply this change safely.", executed_at: new Date().toISOString() }).eq("id", id).eq("owner_user_id", user.id).eq("status", "executing");
    await db.from("mara_tool_runs").update({ status: "failed", error_summary: "The confirmed Voom operation failed safely.", completed_at: new Date().toISOString() }).eq("pending_action_id", id).eq("owner_user_id", user.id);
    return friendlyFailure();
  }
}

async function currentAction(db: Awaited<ReturnType<typeof createClient>>, ownerId: string, id: string) {
  const { data } = await db.from("mara_pending_actions").select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").eq("id", id).eq("owner_user_id", ownerId).maybeSingle();
  if (!data) return Response.json({ error: "That action was not found." }, { status: 404 });
  return Response.json({ action: data, message: data.result_summary ?? "This action was already handled." });
}
function friendlyFailure() { return Response.json({ error: "Voom couldn't apply that change. Nothing unsafe was done—please retry." }, { status: 503 }); }
