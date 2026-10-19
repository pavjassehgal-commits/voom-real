import { getCurrentUser } from "@/lib/voom/server-data";
import { executeConfirmedAction } from "@/lib/mara/tools";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { resyncWorkflowItem } from "@/lib/voom/workflow/service";
import { z } from "zod";
import { productionStatusFor, reelProductionMethods } from "@/lib/mara/reel-production";

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
  if (decision !== "confirm" && decision !== "cancel" && decision !== "edit" && decision !== "production") return Response.json({ error: "Choose a valid Voom action." }, { status: 400 });
  const db = await createClient();
  // Reads stay on the RLS-scoped client; every write goes through the
  // service-role client (owner-filtered), because authenticated users have no
  // direct write access to approval state (migration 0050).
  const admin = createAdminClient();

  if (decision === "production") {
    const method = body && typeof body === "object" && "method" in body ? (body as { method?: unknown }).method : null;
    const parsed = z.enum(reelProductionMethods).safeParse(method);
    if (!parsed.success) return Response.json({ error: "Choose an available production method." }, { status: 400 });
    const { data: current } = await db.from("mara_pending_actions").select("tool_name,sanitized_arguments,new_value,status").eq("id", id).eq("owner_user_id", user.id).eq("status", "pending").maybeSingle();
    if (!current) return currentAction(db, user.id, id);
    const available = Array.isArray(current.new_value?.availableMethods) ? current.new_value.availableMethods : [];
    if (current.tool_name !== "choose_reel_production" || !available.includes(parsed.data)) return Response.json({ error: "That production method is not available for this Reel." }, { status: 400 });
    const productionStatus = productionStatusFor(parsed.data);
    const nextArguments = { ...(current.sanitized_arguments ?? {}), selectedProductionMethod: parsed.data, productionStatus };
    const nextValue = { ...(current.new_value ?? {}), selectedProductionMethod: parsed.data, productionStatus };
    const resultSummary = productionSummary(parsed.data);
    const { data, error } = await admin.from("mara_pending_actions").update({ sanitized_arguments: nextArguments, new_value: nextValue, result_summary: resultSummary, error_summary: null }).eq("id", id).eq("owner_user_id", user.id).eq("status", "pending").select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").single();
    if (error) return friendlyFailure();
    await admin.from("mara_tool_runs").update({ sanitized_arguments: nextArguments, status: "pending_confirmation", result_summary: resultSummary }).eq("pending_action_id", id).eq("owner_user_id", user.id);
    return Response.json({ action: data, message: resultSummary });
  }

  if (decision === "edit") {
    const changes = body && typeof body === "object" && "changes" in body ? (body as { changes?: unknown }).changes : null;
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) return Response.json({ error: "Those changes are not valid." }, { status: 400 });
    const { data: current } = await db.from("mara_pending_actions").select("tool_name,sanitized_arguments,new_value").eq("id", id).eq("owner_user_id", user.id).in("status", ["pending", "failed"]).maybeSingle();
    if (!current) return currentAction(db, user.id, id);
    if (current.tool_name === "propose_calendar_item" && typeof current.sanitized_arguments?.sourceDraftId === "string") {
      const parsed = calendarContentEdit.safeParse(changes);
      if (!parsed.success || new Date(parsed.data.publishAt).getTime() < Date.now() - 300000 || new Date(parsed.data.publishAt).getTime() > Date.now() + 2 * 365 * 86400000) {
        return Response.json({ error: "Enter a caption and a valid future date within the next two years." }, { status: 400 });
      }
      const { error } = await db.rpc("edit_mara_calendar_approval", { p_action_id: id, p_content: parsed.data.content.trim(), p_publish_at: parsed.data.publishAt });
      if (error) return friendlyFailure();
      return currentAction(db, user.id, id, "Draft and schedule updated. Nothing has been applied yet.");
    }
    const allowed = new Set(["title", "channel", "content", "topic", "publishAt", "proposedPublishAt", "name", "objective", "audience", "subject", "previewText", "proposedSendAt", "budget"]);
    const clean = Object.fromEntries(Object.entries(changes as Record<string, unknown>).filter(([key, value]) => allowed.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)));
    if (!Object.keys(clean).length || JSON.stringify(clean).length > 14000) return Response.json({ error: "Those changes are not valid." }, { status: 400 });
    const nextArguments = { ...(current.sanitized_arguments ?? {}), ...clean };
    const { data, error } = await admin.from("mara_pending_actions").update({ sanitized_arguments: nextArguments, new_value: { ...(current.new_value ?? {}), ...clean }, status: "pending", error_summary: null, result_summary: "Updated proposal. Review it before confirming." }).eq("id", id).eq("owner_user_id", user.id).in("status", ["pending", "failed"]).select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").single();
    if (error) return friendlyFailure();
    await admin.from("mara_tool_runs").update({ sanitized_arguments: nextArguments, status: "pending_confirmation", error_summary: null, result_summary: "Proposal edited by the user and awaiting confirmation." }).eq("pending_action_id", id).eq("owner_user_id", user.id);
    return Response.json({ action: data, message: "Proposal updated. Nothing has been applied yet." });
  }

  if (decision === "cancel") {
    const { data, error } = await admin.from("mara_pending_actions").update({ status: "cancelled", result_summary: "Cancelled. Nothing changed.", executed_at: new Date().toISOString() })
      .eq("id", id).eq("owner_user_id", user.id).eq("status", "pending")
      .select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").maybeSingle();
    if (error) return friendlyFailure();
    if (!data) return currentAction(db, user.id, id);
    await admin.from("mara_tool_runs").update({ status: "rejected", result_summary: "Cancelled by the user. Nothing changed.", completed_at: new Date().toISOString() }).eq("pending_action_id", id).eq("owner_user_id", user.id);
    return Response.json({ action: data, message: "Cancelled. Nothing changed." });
  }

  const { data: claimed, error: claimError } = await admin.from("mara_pending_actions").update({ status: "executing", error_summary: null })
    .eq("id", id).eq("owner_user_id", user.id).in("status", ["pending", "failed"])
    .select("id,conversation_id,tool_name,sanitized_arguments,status").maybeSingle();
  if (claimError) return friendlyFailure();
  if (!claimed) return currentAction(db, user.id, id);
  try {
    const result = await executeConfirmedAction({ db: admin, ownerId: user.id, conversationId: claimed.conversation_id }, claimed);
    // Approval advances the SAME workflow item: the approved draft is mirrored
    // onto the Content Calendar and, when its media is ready, into the
    // existing Instagram publishing queue. No second copy is created.
    const sourceDraftId = claimed.sanitized_arguments?.sourceDraftId;
    if (claimed.tool_name === "propose_calendar_item" && typeof sourceDraftId === "string") {
      await resyncWorkflowItem(admin, user.id, sourceDraftId).catch(() => null);
    }
    await admin.from("mara_tool_runs").update({ status: "succeeded", result_summary: result.summary.slice(0, 1000), completed_at: new Date().toISOString() }).eq("pending_action_id", id).eq("owner_user_id", user.id);
    const { data } = await db.from("mara_pending_actions").select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").eq("id", id).eq("owner_user_id", user.id).single();
    return Response.json({ action: data, message: result.summary });
  } catch {
    await admin.from("mara_pending_actions").update({ status: "failed", error_summary: "Voom could not apply this change safely.", executed_at: new Date().toISOString() }).eq("id", id).eq("owner_user_id", user.id).eq("status", "executing");
    await admin.from("mara_tool_runs").update({ status: "failed", error_summary: "The confirmed Voom operation failed safely.", completed_at: new Date().toISOString() }).eq("pending_action_id", id).eq("owner_user_id", user.id);
    return friendlyFailure();
  }
}

async function currentAction(db: Awaited<ReturnType<typeof createClient>>, ownerId: string, id: string, message?: string) {
  const { data } = await db.from("mara_pending_actions").select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").eq("id", id).eq("owner_user_id", ownerId).maybeSingle();
  if (!data) return Response.json({ error: "That action was not found." }, { status: 404 });
  return Response.json({ action: data, message: message ?? data.result_summary ?? "This action was already handled." });
}
function friendlyFailure() { return Response.json({ error: "Voom couldn't apply that change. Nothing unsafe was done—please retry." }, { status: 503 }); }
const calendarContentEdit = z.object({ content: z.string().trim().min(1).max(12000), publishAt: z.string().datetime({ offset: true }) }).strict();
function productionSummary(method: typeof reelProductionMethods[number]) {
  if (method === "create_with_mara") return "Ready for future MARA production. No video has been generated or published.";
  if (method === "film_yourself") return "Waiting for you to film the requested vertical clip. Voom will handle the remaining production later.";
  return "Waiting for one existing asset upload. No file has been uploaded yet.";
}
