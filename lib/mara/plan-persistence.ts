import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateMarketingPlan, marketingPlanSchema, type MarketingPlan } from "@/lib/mara/planning";
import { prepareInstagramPlanWorkflow } from "@/lib/mara/plan-workflow";

type GeneratedPlan = Awaited<ReturnType<typeof generateMarketingPlan>>;

export async function generateAndPersistPlan(db: SupabaseClient, ownerId: string, automationWeekKey?: string) {
  const generated = await generateMarketingPlan(db, ownerId);
  return persistGeneratedPlan(db, ownerId, generated, automationWeekKey);
}

export async function persistGeneratedPlan(db: SupabaseClient, ownerId: string, generated: GeneratedPlan, automationWeekKey?: string) {
  const { plan, businessId, sourceSummary } = generated;
  const row = {
    owner_user_id: ownerId, business_id: businessId, status: "superseded",
    business_goal: plan.businessGoal, weekly_strategy: plan.weeklyStrategy,
    selected_channels: plan.selectedChannels, content_frequency: plan.contentFrequency,
    planned_posts: plan.plannedPosts, planned_campaigns: plan.plannedCampaigns,
    recommendations: plan.recommendations, source_summary: sourceSummary,
    valid_from: plan.validFrom, valid_until: plan.validUntil,
    automation_week_key: automationWeekKey ?? null,
  };
  const insert = await db.from("marketing_plans").insert(row).select("*").maybeSingle();
  if (insert.error && !(automationWeekKey && insert.error.code === "23505")) throw new Error("plan_store_failed");
  const stored = insert.data ?? (automationWeekKey ? await findAutomatedPlan(db, ownerId, automationWeekKey) : null);
  if (!stored) throw new Error("plan_store_failed");
  await ensurePlanWorkflow(db, ownerId, stored, insert.data ? plan : storedPlan(stored));
  const { error: supersedeError } = await db.from("marketing_plans").update({ status: "superseded" }).eq("owner_user_id", ownerId).eq("status", "active").neq("id", stored.id);
  if (supersedeError) throw new Error("plan_supersede_failed");
  const { data: active, error: activateError } = await db.from("marketing_plans").update({ status: "active" }).eq("owner_user_id", ownerId).eq("id", stored.id).select("*").single();
  if (activateError) throw new Error("plan_activate_failed");
  return { plan: active, workflowReady: true, created: Boolean(insert.data) };
}

export async function resumeAutomatedPlan(db: SupabaseClient, ownerId: string, stored: Record<string, unknown>) {
  await ensurePlanWorkflow(db, ownerId, stored, storedPlan(stored));
  const { error: supersedeError } = await db.from("marketing_plans").update({ status: "superseded" }).eq("owner_user_id", ownerId).eq("status", "active").neq("id", stored.id as string);
  if (supersedeError) throw new Error("plan_supersede_failed");
  const { error: activateError } = await db.from("marketing_plans").update({ status: "active" }).eq("owner_user_id", ownerId).eq("id", stored.id as string);
  if (activateError) throw new Error("plan_activate_failed");
}

async function ensurePlanWorkflow(db: SupabaseClient, ownerId: string, stored: Record<string, unknown>, plan: MarketingPlan) {
  const result = await prepareInstagramPlanWorkflow(db, ownerId, stored.id as string, plan);
  if (result.pendingActionIds.length !== 3) throw new Error("plan_workflow_failed");
}

async function findAutomatedPlan(db: SupabaseClient, ownerId: string, weekKey: string) {
  const { data, error } = await db.from("marketing_plans").select("*").eq("owner_user_id", ownerId).eq("automation_week_key", weekKey).maybeSingle();
  if (error) throw new Error("plan_lookup_failed");
  return data;
}

function storedPlan(row: Record<string, unknown>) {
  return marketingPlanSchema.parse({
    businessGoal: row.business_goal, weeklyStrategy: row.weekly_strategy,
    selectedChannels: row.selected_channels, contentFrequency: row.content_frequency,
    plannedPosts: row.planned_posts, plannedCampaigns: row.planned_campaigns,
    recommendations: row.recommendations, validFrom: row.valid_from, validUntil: row.valid_until,
  });
}
