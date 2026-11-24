import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

const COLUMNS = "id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at";

/** Open decisions must stay visible even after newer activity fills the history preview. */
export async function loadApprovalFeed(db: SupabaseClient, ownerId: string, pendingOnly = false) {
  const query = () => db.from("mara_pending_actions").select(COLUMNS).eq("owner_user_id", ownerId);
  const openPage = (after?: string) => {
    const page = query().in("status", pendingOnly ? ["pending"] : ["pending", "failed"]).order("id").limit(250);
    return after ? page.gt("id", after) : page;
  };
  const [recent, first] = await Promise.all([
    pendingOnly ? null : query().order("created_at", { ascending: false }).limit(50),
    openPage(),
  ]);
  if (recent?.error) throw new Error("approval_feed_unavailable");
  const actions = new Map((recent?.data ?? []).map((row) => [row.id, row]));
  let page = first;
  while (true) {
    if (page.error) throw new Error("approval_feed_unavailable");
    for (const row of page.data) actions.set(row.id, row);
    if (page.data.length < 250) break;
    page = await openPage(page.data[page.data.length - 1].id);
  }
  const legacy = [...actions.values()].filter((row) => row.tool_name === "approve_draft" && typeof row.new_value?.draftId === "string");
  if (legacy.length) {
    const { data: drafts, error } = await db.from("mara_drafts").select("id,kind").eq("owner_user_id", ownerId).in("id", legacy.map((row) => row.new_value.draftId));
    if (error) throw new Error("approval_feed_unavailable");
    const kinds = new Map((drafts ?? []).map((row) => [row.id, row.kind]));
    for (const row of legacy) row.new_value = { ...row.new_value, draftKind: kinds.get(row.new_value.draftId) ?? "missing" };
  }
  return [...actions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}
