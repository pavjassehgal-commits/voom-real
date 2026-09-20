import "server-only";
import type { createClient } from "@/utils/supabase/server";

export type ServerSupabase = Awaited<ReturnType<typeof createClient>>;

export async function getBrandProfile(db: ServerSupabase, ownerId: string) {
  const [{ data: profile, error: profileError }, { data: business, error: businessError }] = await Promise.all([
    db.from("profiles").select("display_name").eq("user_id", ownerId).maybeSingle(),
    db.from("businesses").select("brand_name,brand_description,industry,target_customer,main_goal,brand_personality,preferred_channels,content_frequency,monthly_ad_budget,automation_level,publishing_permission").eq("owner_user_id", ownerId).maybeSingle(),
  ]);
  if (profileError || businessError) throw new Error("brand_profile_unavailable");
  return { name: profile?.display_name ?? null, ...(business ?? {}) };
}

export async function listCalendarItems(db: ServerSupabase, ownerId: string, input: { start: string; end: string; channel?: string }) {
  let query = db.from("content_calendar_items")
    .select("id,title,channel,content,topic,publish_at,status,source_draft_id,created_at,updated_at")
    .eq("owner_user_id", ownerId).gte("publish_at", input.start).lte("publish_at", input.end)
    .order("publish_at", { ascending: true }).limit(100);
  if (input.channel) query = query.eq("channel", input.channel);
  const { data, error } = await query;
  if (error) throw new Error("calendar_unavailable");
  return data ?? [];
}

export async function getCalendarItem(db: ServerSupabase, ownerId: string, id: string) {
  const { data, error } = await db.from("content_calendar_items")
    .select("id,title,channel,content,topic,publish_at,status,source_draft_id,created_at,updated_at")
    .eq("owner_user_id", ownerId).eq("id", id).maybeSingle();
  if (error) throw new Error("calendar_unavailable");
  return data;
}

export async function createCalendarItem(db: ServerSupabase, ownerId: string, input: Record<string, unknown>) {
  const value = { ...input, owner_user_id: ownerId };
  const query = input.source_draft_id
    ? db.from("content_calendar_items").upsert(value, { onConflict: "owner_user_id,source_draft_id" })
    : db.from("content_calendar_items").insert(value);
  const { data, error } = await query
    .select("id,title,channel,content,topic,publish_at,status,source_draft_id,created_at,updated_at").single();
  if (error) throw new Error("calendar_create_failed");
  return data;
}

export async function updateCalendarItem(db: ServerSupabase, ownerId: string, id: string, input: Record<string, unknown>) {
  const { data, error } = await db.from("content_calendar_items").update(input).eq("owner_user_id", ownerId).eq("id", id)
    .select("id,title,channel,content,topic,publish_at,status,source_draft_id,created_at,updated_at").maybeSingle();
  if (error) throw new Error("calendar_update_failed");
  return data;
}

export async function deleteCalendarItem(db: ServerSupabase, ownerId: string, id: string) {
  const existing = await getCalendarItem(db, ownerId, id);
  if (!existing) return null;
  const { error } = await db.from("content_calendar_items").delete().eq("owner_user_id", ownerId).eq("id", id);
  if (error) throw new Error("calendar_delete_failed");
  return existing;
}

export async function listDrafts(db: ServerSupabase, ownerId: string, status?: string) {
  let query = db.from("mara_drafts").select("id,conversation_id,message_id,kind,channel,title,content,proposed_publish_at,status,created_at,updated_at")
    .eq("owner_user_id", ownerId).order("created_at", { ascending: false }).limit(50);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw new Error("drafts_unavailable");
  return data ?? [];
}

export async function getDraft(db: ServerSupabase, ownerId: string, id: string) {
  const { data, error } = await db.from("mara_drafts").select("id,conversation_id,message_id,kind,channel,title,content,proposed_publish_at,status,created_at,updated_at")
    .eq("owner_user_id", ownerId).eq("id", id).maybeSingle();
  if (error) throw new Error("draft_unavailable");
  return data;
}

const CAMPAIGN_COLUMNS = "id,kind,is_automated,parent_campaign_id,name,objective,audience,audience_id,subject,preview_text,content,cta_url,proposed_send_at,status,goal,start_at,end_at,offer_details,campaign_notes,generated_summary,channels,creation_method,approved_at,created_at,updated_at";

export async function listCampaigns(db: ServerSupabase, ownerId: string, kind?: string) {
  let query = db.from("voom_campaigns").select(CAMPAIGN_COLUMNS)
    .eq("owner_user_id", ownerId).order("updated_at", { ascending: false }).limit(200);
  if (kind) query = query.eq("kind", kind);
  const { data, error } = await query;
  if (error) throw new Error("campaigns_unavailable");
  return data ?? [];
}

export async function getCampaign(db: ServerSupabase, ownerId: string, id: string) {
  const { data, error } = await db.from("voom_campaigns").select(CAMPAIGN_COLUMNS)
    .eq("owner_user_id", ownerId).eq("id", id).maybeSingle();
  if (error) throw new Error("campaign_unavailable");
  return data;
}

export async function createCampaign(db: ServerSupabase, ownerId: string, input: Record<string, unknown>) {
  const { data, error } = await db.from("voom_campaigns").insert({ ...input, owner_user_id: ownerId, status: "draft" })
    .select(CAMPAIGN_COLUMNS).single();
  if (error) throw new Error("campaign_create_failed");
  return data;
}

export async function updateCampaign(db: ServerSupabase, ownerId: string, id: string, input: Record<string, unknown>) {
  const { data, error } = await db.from("voom_campaigns").update({ ...input, status: "draft" }).eq("owner_user_id", ownerId).eq("id", id)
    .select(CAMPAIGN_COLUMNS).maybeSingle();
  if (error) throw new Error("campaign_update_failed");
  return data;
}

export async function approveCampaign(db: ServerSupabase, ownerId: string, id: string) {
  const { data, error } = await db.from("voom_campaigns").update({ status: "approved" }).eq("owner_user_id", ownerId).eq("id", id)
    .select(CAMPAIGN_COLUMNS).maybeSingle();
  if (error) throw new Error("campaign_approve_failed");
  return data;
}

export async function rejectCampaign(db: ServerSupabase, ownerId: string, id: string) {
  const { data, error } = await db.from("voom_campaigns").update({ status: "rejected" }).eq("owner_user_id", ownerId).eq("id", id)
    .select(CAMPAIGN_COLUMNS).maybeSingle();
  if (error) throw new Error("campaign_reject_failed");
  return data;
}

/** The automated-campaign timeline actions for one container, slot ordered. */
export async function listCampaignActions(db: ServerSupabase, ownerId: string, campaignId: string) {
  const { data, error } = await db.from("voom_campaign_actions")
    .select("id,campaign_id,slot,channel,stage,title,purpose,scheduled_for,status,email_campaign_id,draft_id,safety_blockers,created_at,updated_at")
    .eq("owner_user_id", ownerId).eq("campaign_id", campaignId).order("slot", { ascending: true });
  if (error) throw new Error("campaign_actions_unavailable");
  return (data ?? []) as Array<Record<string, unknown>>;
}
