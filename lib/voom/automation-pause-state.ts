import "server-only";

import type { createAdminClient } from "@/utils/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * The owner's emergency-pause state (migration 0059), read-only. `null` when
 * it cannot be read: the screen then says the state is unknown instead of
 * guessing "running".
 */
export async function readAutomationPauseState(admin: AdminClient, ownerId: string): Promise<{ pausedAt: string | null } | null> {
  const { data, error } = await admin.from("businesses").select("automation_paused_at").eq("owner_user_id", ownerId).maybeSingle();
  if (error || !data) return null;
  const value = (data as { automation_paused_at?: string | null }).automation_paused_at;
  return { pausedAt: typeof value === "string" ? value : null };
}
