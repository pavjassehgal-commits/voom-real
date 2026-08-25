"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { getCurrentUser } from "./server-data";
import type { BusinessProfileInput } from "./types";

export type SaveResult = { ok: true } | { ok: false; error: string };

const GENERIC_ERROR = "We couldn't save that. Please try again.";

function saveError(error: { code?: string }): string {
  if (error.code === "42501") {
    return "Voom's database permissions are not configured yet. Apply the latest Supabase migration, then try again.";
  }
  return GENERIC_ERROR;
}

export async function saveOnboarding(input: BusinessProfileInput): Promise<SaveResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please log in again." };

  const supabase = await createClient();

  const { error: profileError } = await supabase
    .from("profiles")
    .upsert({ user_id: user.id, display_name: input.displayName.trim() || null }, { onConflict: "user_id" });
  if (profileError) return { ok: false, error: saveError(profileError) };

  const { error: businessError } = await supabase.from("businesses").upsert(
    {
      owner_user_id: user.id,
      brand_name: input.brandName.trim() || null,
      brand_description: input.brandDescription.trim() || null,
      industry: input.industry || null,
      target_customer: input.targetCustomer,
      main_goal: input.mainGoal || null,
      brand_personality: input.brandPersonality,
      preferred_channels: input.preferredChannels,
      monthly_ad_budget: input.monthlyAdBudget || null,
      content_frequency: input.contentFrequency || null,
      automation_level: input.automationLevel || null,
      publishing_permission: input.publishingPermission || null,
      onboarding_completed: true,
    },
    { onConflict: "owner_user_id" },
  );
  if (businessError) return { ok: false, error: saveError(businessError) };

  revalidatePath("/app", "layout");
  return { ok: true };
}

export async function saveBrandSettings(input: BusinessProfileInput): Promise<SaveResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please log in again." };

  const supabase = await createClient();

  const { error: profileError } = await supabase
    .from("profiles")
    .upsert({ user_id: user.id, display_name: input.displayName.trim() || null }, { onConflict: "user_id" });
  if (profileError) return { ok: false, error: saveError(profileError) };

  const { error: businessError } = await supabase.from("businesses").upsert(
    {
      owner_user_id: user.id,
      brand_name: input.brandName.trim() || null,
      brand_description: input.brandDescription.trim() || null,
      industry: input.industry || null,
      target_customer: input.targetCustomer,
      main_goal: input.mainGoal || null,
      brand_personality: input.brandPersonality,
      preferred_channels: input.preferredChannels,
      monthly_ad_budget: input.monthlyAdBudget || null,
      content_frequency: input.contentFrequency || null,
      automation_level: input.automationLevel || null,
      publishing_permission: input.publishingPermission || null,
    },
    { onConflict: "owner_user_id" },
  );
  if (businessError) return { ok: false, error: saveError(businessError) };

  revalidatePath("/app", "layout");
  return { ok: true };
}

export async function restartOnboarding(): Promise<SaveResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please log in again." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("businesses")
    .update({ onboarding_completed: false })
    .eq("owner_user_id", user.id);
  if (error) return { ok: false, error: saveError(error) };

  revalidatePath("/app", "layout");
  return { ok: true };
}
