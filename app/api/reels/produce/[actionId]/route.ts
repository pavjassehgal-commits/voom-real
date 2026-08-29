import { getCurrentUser } from "@/lib/voom/server-data";
import { createAiProvider } from "@/lib/ai";
import { buildReelComposition, isReelComposition } from "@/lib/mara/reel-composition";
import { enforceViewerCopy, fallbackViewerCopy, viewerCopySchema, type ViewerCopyContext } from "@/lib/mara/reel-copy";
import { classifyReelProduction } from "@/lib/mara/reel-production";
import { assetKindForMime, assignReelVisuals } from "@/lib/mara/reel-visuals";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_COLUMNS = "id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at";

const REEL_COPY_SYSTEM_PROMPT = `You write the exact on-screen text for one short-form 9:16 social Reel. Return JSON only with exactly these keys: {"hook":"string","message":"string","value":"string","cta":"string"}.
Rules:
- hook: 3-8 words, viewer-facing, attention-grabbing.
- message: 4-10 words stating the main point plainly.
- value: 4-10 words of supporting reason grounded ONLY in the supplied concept and caption.
- cta: at most 6 words, one short action; it may end with an arrow character.
- Never output production or shot direction. Forbidden on-screen words include: opening shot, quick cuts, close-up, end frame, cut, scene, frame, camera, angle, transition, B-roll, voice-over, payoff, shot list, call to action, CTA. Never mention the internal script or shot instructions themselves.
- Never invent prices, discounts, offers, guarantees, store locations, links, or claims not present in the supplied caption/concept. Never fabricate the business identity.
- No hashtags, no URLs, no screen-reader notes, no captions like "text here". Plain concise marketing copy only.`;


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
  const { data: assetRows } = await admin.from("reel_draft_assets").select("id,mime_type,created_at").eq("owner_user_id", user.id).eq("draft_id", action.new_value.draftId).order("created_at").order("id").limit(6);
  const assetPack = (assetRows ?? []).filter((row) => typeof row.id === "string" && assetKindForMime(String(row.mime_type)) !== null);
  const usesAsset = assetPack.length > 0;
  if (assetReceived && !usesAsset) return Response.json({ error: "The required private asset could not be verified." }, { status: 409 });
  const preparing = { ...action.new_value, selectedProductionMethod: "create_with_mara", productionStatus: "preparing" };
  const { error: preparingError } = await db.from("mara_pending_actions").update({ new_value: preparing, sanitized_arguments: { ...(action.new_value ?? {}), selectedProductionMethod: "create_with_mara", productionStatus: "preparing" }, result_summary: "Preparing the live Voom Reel composition." }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending");
  if (preparingError) return Response.json({ error: "Voom couldn't start Reel production safely." }, { status: 503 });

  const [{ data: draft }, { data: business }] = await Promise.all([
    db.from("mara_drafts").select("title,content").eq("id", action.new_value.draftId).eq("owner_user_id", user.id).maybeSingle(),
    db.from("businesses").select("brand_name,brand_description,industry,target_customer,main_goal").eq("owner_user_id", user.id).maybeSingle(),
  ]);
  if (!draft) return fail(db, user.id, actionId, preparing, "The owned Reel draft could not be loaded.");
  const producing = { ...preparing, productionStatus: "producing" };
  const { error: producingError } = await db.from("mara_pending_actions").update({ new_value: producing, result_summary: "Producing timed scenes, overlays, branding, and the review player." }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending");
  if (producingError) return fail(db, user.id, actionId, preparing, "Voom couldn't persist the production state.");
  const concept = String(action.new_value.concept ?? draft.title);
  const brandName = business?.brand_name ?? "Your business";
  const caption = draft.content;
  const copyContext: ViewerCopyContext = { concept, caption, brandName };
  // Viewer-facing copy is generated from TEXT ONLY (concept, caption, business
  // context). Uploaded private media is never sent to the AI provider. If the
  // provider is unavailable or returns unsafe copy, the deterministic fallback
  // keeps production working — internal shot directions never reach the screen.
  let viewerCopy = fallbackViewerCopy(copyContext);
  try {
    const provider = createAiProvider();
    const generated = await provider.structured({
      messages: [
        { role: "system", content: REEL_COPY_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({
          business: { name: brandName, description: String(business?.brand_description ?? "").slice(0, 800), industry: String(business?.industry ?? "").slice(0, 200), targetCustomer: String(business?.target_customer ?? "").slice(0, 300), mainGoal: String(business?.main_goal ?? "").slice(0, 300) },
          concept,
          caption,
          internalScriptForInterpretationOnly: String(action.new_value.script ?? "").slice(0, 1200),
          internalShotDirectionsForInterpretationOnly: (Array.isArray(action.new_value.shotInstructions) ? action.new_value.shotInstructions : []).slice(0, 5),
        }) },
      ],
      temperature: 0.25,
      maxTokens: 300,
      parse: (value) => viewerCopySchema.parse(value),
    });
    viewerCopy = enforceViewerCopy(generated, copyContext);
  } catch {
    viewerCopy = fallbackViewerCopy(copyContext);
  }
  const visuals = assignReelVisuals(assetPack.map((row) => ({ id: row.id, mimeType: String(row.mime_type), kind: assetKindForMime(String(row.mime_type)) as "image" | "video" })));
  const composition = buildReelComposition({ concept, caption, brandName, usesAsset, viewerCopy, visuals });
  const produced = { ...producing, productionStatus: "produced", assetReceived, assetCount: assetPack.length, reelComposition: composition };
  const { data: completed, error } = await db.from("mara_pending_actions").update({ new_value: produced, sanitized_arguments: { ...(action.new_value ?? {}), selectedProductionMethod: "create_with_mara", productionStatus: "produced" }, result_summary: "Produced a playable live Voom Reel composition with viewer-facing scenes. Ready for review; nothing was published.", error_summary: null }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending").select(ACTION_COLUMNS).single();
  if (error) return fail(db, user.id, actionId, producing, "Voom couldn't finish Reel production safely.");
  return Response.json({ action: completed, message: "Reel produced and ready for review." });
}

async function fail(db: Awaited<ReturnType<typeof createClient>>, ownerId: string, actionId: string, value: Record<string, unknown>, message: string) {
  await db.from("mara_pending_actions").update({ new_value: { ...value, productionStatus: "production_failed" }, error_summary: message, result_summary: "Reel production stopped safely. Nothing was published." }).eq("id", actionId).eq("owner_user_id", ownerId).eq("status", "pending");
  return Response.json({ error: message }, { status: 503 });
}
