import { cache } from "react";
import { createClient } from "@/utils/supabase/server";
import { getAuthUser } from "@/lib/auth/server";
import { isVerifiedUser } from "@/lib/auth/policy";
import type { BusinessRecord, ProfileRecord } from "./types";

export const getCurrentUser = cache(async (): Promise<{ id: string; email: string | null } | null> => {
  const user = await getAuthUser();
  if (!isVerifiedUser(user)) return null;
  return { id: user.id, email: user.email ?? null };
});

export const getBusinessRecord = cache(async (): Promise<BusinessRecord | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createClient();
  const { data } = await supabase.from("businesses").select("*").eq("owner_user_id", user.id).maybeSingle();
  return (data as BusinessRecord | null) ?? null;
});

export const getProfileRecord = cache(async (): Promise<ProfileRecord | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle();
  return (data as ProfileRecord | null) ?? null;
});
