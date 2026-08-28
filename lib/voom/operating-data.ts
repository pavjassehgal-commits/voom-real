import "server-only";

import { createClient } from "@/utils/supabase/server";
import { getCurrentUser, getBusinessRecord } from "./server-data";

export async function getOperatingData() {
  const [user, business] = await Promise.all([getCurrentUser(), getBusinessRecord()]);
  if (!user || !business) return null;
  const db = await createClient();
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);
  const upcomingEnd = new Date(now.getTime() + 30 * 86400000);
  const [today, upcoming, actions, activity, campaigns, plan] = await Promise.all([
    db.from("content_calendar_items").select("id,title,channel,publish_at,status,topic").eq("owner_user_id", user.id).gte("publish_at", todayStart.toISOString()).lt("publish_at", todayEnd.toISOString()).order("publish_at"),
    db.from("content_calendar_items").select("id,title,channel,publish_at,status,topic").eq("owner_user_id", user.id).gte("publish_at", now.toISOString()).lte("publish_at", upcomingEnd.toISOString()).order("publish_at").limit(8),
    db.from("mara_pending_actions").select("id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at").eq("owner_user_id", user.id).order("created_at", { ascending: false }).limit(50),
    db.from("mara_tool_runs").select("id,tool_name,status,result_summary,error_summary,started_at,completed_at").eq("owner_user_id", user.id).order("started_at", { ascending: false }).limit(8),
    db.from("voom_campaigns").select("id,name,kind,status,proposed_send_at,updated_at").eq("owner_user_id", user.id).order("updated_at", { ascending: false }).limit(8),
    db.from("marketing_plans").select("*").eq("owner_user_id", user.id).eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return {
    user, business,
    today: today.data ?? [], upcoming: upcoming.data ?? [],
    actions: actions.data ?? [], activity: activity.data ?? [], campaigns: campaigns.data ?? [],
    plan: plan.error ? null : plan.data,
    planStorageReady: !plan.error,
  };
}
