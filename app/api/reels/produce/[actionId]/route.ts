import { getCurrentUser } from "@/lib/voom/server-data";
import { buildReelComposition, isReelComposition } from "@/lib/mara/reel-composition";
import { classifyReelProduction } from "@/lib/mara/reel-production";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_COLUMNS = "id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at";

export async function POST(_request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { actionId } = await params;
  if (!UUID_RE.test(actionId)) return Response.json({ error: "That Reel request is not valid." }, { status: 400 });
  const db = await createClient();
  const { data: action } = await db.from("mara_pending_actions").select(ACTION_COLUMNS).eq("id", actionId).eq("owner_user_id", user.id).eq("tool_name", "choose_reel_production").eq("status", "pending").maybeSingle();
  if (!action || !action.new_value || typeof action.new_value.draftId !== "string") return Response.json({ error: "That Reel request was not found." }, { status: 404 });
  if (isReelComposition(action.new_value.reelComposition) && action.new_value.productionStatus === "produced") return Response.json({ action, message: "This Reel is already produced and ready for review." });

  const capability = classifyReelProduction({ concept: String(action.new_value.concept ?? ""), script: String(action.new_value.script ?? ""), shotInstructions: Array.isArray(action.new_value.shotInstructions) ? action.new_value.shotInstructions.filter((shot: unknown): shot is string => typeof shot === "string") : [] });
  const assetReceived = action.new_value.assetReceived === true;
  if (!capability.availableMethods.includes("create_with_mara") && !assetReceived) return Response.json({ error: "Upload the requested real-world asset before Voom produces this Reel." }, { status: 409 });
  const admin = createAdminClient();
  let usesAsset = false;
  if (assetReceived) {
    const { data: asset } = await admin.from("reel_draft_assets").select("id").eq("owner_user_id", user.id).eq("draft_id", action.new_value.draftId).maybeSingle();
    if (!asset) return Response.json({ error: "The required private asset could not be verified." }, { status: 409 });
    usesAsset = true;
  }
  const preparing = { ...action.new_value, selectedProductionMethod: "create_with_mara", productionStatus: "preparing" };
  const { error: preparingError } = await db.from("mara_pending_actions").update({ new_value: preparing, sanitized_arguments: { ...(action.new_value ?? {}), selectedProductionMethod: "create_with_mara", productionStatus: "preparing" }, result_summary: "Preparing the live Voom Reel composition." }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending");
  if (preparingError) return Response.json({ error: "Voom couldn't start Reel production safely." }, { status: 503 });

  const [{ data: draft }, { data: business }] = await Promise.all([
    db.from("mara_drafts").select("title,content").eq("id", action.new_value.draftId).eq("owner_user_id", user.id).maybeSingle(),
    db.from("businesses").select("brand_name").eq("owner_user_id", user.id).maybeSingle(),
  ]);
  if (!draft) return fail(db, user.id, actionId, preparing, "The owned Reel draft could not be loaded.");
  const producing = { ...preparing, productionStatus: "producing" };
  const { error: producingError } = await db.from("mara_pending_actions").update({ new_value: producing, result_summary: "Producing timed scenes, overlays, branding, and the review player." }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending");
  if (producingError) return fail(db, user.id, actionId, preparing, "Voom couldn't persist the production state.");
  const composition = buildReelComposition({ concept: String(action.new_value.concept ?? draft.title), script: String(action.new_value.script ?? draft.content), caption: draft.content, brandName: business?.brand_name ?? "Your business", usesAsset });
  const produced = { ...producing, productionStatus: "produced", assetReceived, reelComposition: composition };
  const { data: completed, error } = await db.from("mara_pending_actions").update({ new_value: produced, sanitized_arguments: { ...(action.new_value ?? {}), selectedProductionMethod: "create_with_mara", productionStatus: "produced" }, result_summary: "Produced a playable live Voom Reel composition. Ready for review; nothing was published.", error_summary: null }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending").select(ACTION_COLUMNS).single();
  if (error) return fail(db, user.id, actionId, producing, "Voom couldn't finish Reel production safely.");
  return Response.json({ action: completed, message: "Reel produced and ready for review." });
}

async function fail(db: Awaited<ReturnType<typeof createClient>>, ownerId: string, actionId: string, value: Record<string, unknown>, message: string) {
  await db.from("mara_pending_actions").update({ new_value: { ...value, productionStatus: "production_failed" }, error_summary: message, result_summary: "Reel production stopped safely. Nothing was published." }).eq("id", actionId).eq("owner_user_id", ownerId).eq("status", "pending");
  return Response.json({ error: message }, { status: 503 });
}
