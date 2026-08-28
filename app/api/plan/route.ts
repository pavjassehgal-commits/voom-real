import { AiError } from "@/lib/ai";
import { generateMarketingPlan } from "@/lib/mara/planning";
import { prepareInstagramPlanWorkflow } from "@/lib/mara/plan-workflow";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const db = await createClient();
  const { data, error } = await db.from("marketing_plans").select("*").eq("owner_user_id", user.id).eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) return Response.json({ plan: null, storageReady: false });
  return Response.json({ plan: data, storageReady: true }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const db = await createClient();
  const admin = createAdminClient();
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { count, error: countError } = await admin.from("marketing_plans").select("id", { count: "exact", head: true }).eq("owner_user_id", user.id).gte("created_at", since);
  if (countError) return Response.json({ error: "Plan storage is not ready yet." }, { status: 503 });
  if ((count ?? 0) >= 3) return Response.json({ error: "You have refreshed recently. Please wait a few minutes and try again." }, { status: 429 });
  try {
    const { plan, businessId, sourceSummary } = await generateMarketingPlan(db, user.id);
    const { data: staged, error: stageError } = await admin.from("marketing_plans").insert({
      owner_user_id: user.id, business_id: businessId, status: "superseded",
      business_goal: plan.businessGoal, weekly_strategy: plan.weeklyStrategy,
      selected_channels: plan.selectedChannels, content_frequency: plan.contentFrequency,
      planned_posts: plan.plannedPosts, planned_campaigns: plan.plannedCampaigns,
      recommendations: plan.recommendations, source_summary: sourceSummary,
      valid_from: plan.validFrom, valid_until: plan.validUntil,
    }).select("id").single();
    if (stageError || !staged) throw new Error("plan_store_failed");
    await admin.from("marketing_plans").update({ status: "superseded" }).eq("owner_user_id", user.id).eq("status", "active");
    const { data, error } = await admin.from("marketing_plans").update({ status: "active" }).eq("id", staged.id).eq("owner_user_id", user.id).select("*").single();
    if (error) throw new Error("plan_activate_failed");
    const workflow = await prepareInstagramPlanWorkflow(db, user.id, data.id, plan);
    return Response.json({ plan: data, workflow });
  } catch (error) {
    const message = error instanceof AiError && error.code === "rate_limited"
      ? "Voom's planning engine is busy. Please try again shortly."
      : "Voom couldn't build your plan right now. Your existing work is safe—please retry.";
    return Response.json({ error: message }, { status: error instanceof AiError && error.code === "rate_limited" ? 429 : 503 });
  }
}
