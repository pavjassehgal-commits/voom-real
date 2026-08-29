import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateAndPersistPlan, resumeAutomatedPlan } from "@/lib/mara/plan-persistence";
import { createAdminClient } from "@/utils/supabase/admin";
import { dubaiWeek } from "@/lib/voom/weekly-cycle";

const AUTOMATED_MODES = ["assisted", "autopilot"];

export async function runWeeklyPlanAutomation(now = new Date(), db: SupabaseClient = createAdminClient(), ownerIds?: string[]) {
  const { weekKey, cycleStartIso } = dubaiWeek(now);
  let businessesQuery = db.from("businesses").select("owner_user_id,automation_level").eq("onboarding_completed", true).in("automation_level", AUTOMATED_MODES);
  if (ownerIds) businessesQuery = businessesQuery.in("owner_user_id", ownerIds);
  const { data: businesses, error } = await businessesQuery;
  if (error) throw new Error("automation_businesses_unavailable");
  const result = { checked: businesses?.length ?? 0, created: 0, resumed: 0, skipped: 0, failed: 0 };
  for (const business of businesses ?? []) {
    try {
      const outcome = await ensureOwnerWeek(db, business.owner_user_id, business.automation_level === "autopilot", weekKey, cycleStartIso, now);
      result[outcome] += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

async function ensureOwnerWeek(db: SupabaseClient, ownerId: string, autopilot: boolean, weekKey: string, cycleStartIso: string, now: Date): Promise<"created" | "resumed" | "skipped"> {
  const existing = await db.from("marketing_plans").select("*").eq("owner_user_id", ownerId).eq("automation_week_key", weekKey).maybeSingle();
  if (existing.error) throw new Error("automation_plan_lookup_failed");
  if (existing.data) { await resumeAutomatedPlan(db, ownerId, existing.data, autopilot); return "resumed"; }

  const current = await db.from("marketing_plans").select("id,created_at,valid_until").eq("owner_user_id", ownerId).eq("status", "active").gte("created_at", cycleStartIso).gte("valid_until", dubaiDate(now)).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (current.error) throw new Error("automation_current_plan_lookup_failed");
  if (current.data) return "skipped";

  const persisted = await generateAndPersistPlan(db, ownerId, weekKey, autopilot);
  return persisted.created ? "created" : "resumed";
}

function dubaiDate(value: Date) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(value); }
