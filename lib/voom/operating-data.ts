import "server-only";

import { createClient } from "@/utils/supabase/server";
import { getCurrentUser, getBusinessRecord } from "./server-data";

export async function getOperatingData() {
  const [user, business] = await Promise.all([getCurrentUser(), getBusinessRecord()]);
  if (!user || !business) return null;
  const db = await createClient();
  const now = new Date().toISOString();
  const [pendingApprovals, nextScheduled, plan, actions] = await Promise.all([
    db.from("mara_pending_actions").select("id", { count: "exact", head: true }).eq("owner_user_id", user.id).eq("tool_name", "propose_calendar_item").eq("status", "pending"),
    db.from("content_calendar_items").select("title,channel,content,publish_at,status").eq("owner_user_id", user.id).in("status", ["approved", "scheduled"]).gte("publish_at", now).order("publish_at").limit(1).maybeSingle(),
    db.from("marketing_plans").select("*").eq("owner_user_id", user.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("mara_pending_actions").select("id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").eq("owner_user_id", user.id).order("created_at", { ascending: false }).limit(50),
  ]);
  return { user, business, pendingApprovalCount: pendingApprovals.error ? 0 : pendingApprovals.count ?? 0, nextScheduled: nextScheduled.error ? null : nextScheduled.data, plan: plan.error ? null : plan.data, planStorageReady: !plan.error, actions: actions.data ?? [] };
}
