/**
 * Brand Hub reads (Brand Kit v2, slice 2): the newest kit version and the
 * recent history for the logged-in owner. Works on the user-scoped client
 * (RLS limits rows to the caller) and never throws: a missing table reads as
 * "no kit yet" so the page still renders from the `businesses` row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { BRAND_KIT_TABLE } from "./context";
import { cleanBrandAssets } from "./assets";
import type { BrandKitVersionView } from "./sections";

export const BRAND_HISTORY_LIMIT = 20;

export function brandKitVersionView(row: Record<string, unknown>): BrandKitVersionView {
  const answers = row.answers && typeof row.answers === "object" && !Array.isArray(row.answers) ? (row.answers as Record<string, unknown>) : {};
  return {
    version: typeof row.version === "number" ? row.version : Number(row.version ?? 0),
    answers,
    brief: typeof row.brief === "string" ? row.brief : "",
    assets: cleanBrandAssets(row.assets ?? []) ?? [],
    source: typeof row.source === "string" ? row.source : "",
    changeSummary: typeof row.change_summary === "string" ? row.change_summary : "",
    changedKeys: Array.isArray(row.changed_keys) ? row.changed_keys.map(String) : [],
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
  };
}

/** Newest first. `history[0]` is the current version, or the list is empty. */
export async function loadBrandKitHistory(db: SupabaseClient, ownerId: string, limit = BRAND_HISTORY_LIMIT): Promise<BrandKitVersionView[]> {
  try {
    const { data, error } = await db.from(BRAND_KIT_TABLE)
      .select("version,answers,brief,assets,source,change_summary,changed_keys,created_at")
      .eq("owner_user_id", ownerId)
      .order("version", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[brand-kit] history read failed", error.message);
      return [];
    }
    return (Array.isArray(data) ? data : []).map((row) => brandKitVersionView(row as Record<string, unknown>));
  } catch (reason) {
    console.error("[brand-kit] history read failed", reason instanceof Error ? reason.message : String(reason));
    return [];
  }
}
