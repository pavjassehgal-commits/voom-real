"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { getCurrentUser } from "./server-data";
import { normalizeMediaSpendSettings, type MediaSpendSettings } from "@/lib/mara/media-spend";
import { normalizeWebsiteUrl, WEBSITE_NOT_SAVED_NOTICE } from "./website";
import type { BusinessProfileInput, OnboardingInput } from "./types";

/** `notice` is a non-fatal message worth showing (the save itself succeeded). */
export type SaveResult = { ok: true; notice?: string } | { ok: false; error: string };

const GENERIC_ERROR = "We couldn't save that. Please try again.";

function saveError(error: { code?: string }): string {
  if (error.code === "42501") {
    return "Voom's database permissions are not configured yet. Apply the latest Supabase migration, then try again.";
  }
  return GENERIC_ERROR;
}

export async function saveOnboarding(input: OnboardingInput): Promise<SaveResult> {
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

  const websiteSaved = await saveOnboardingWebsite(user.id, input.website);

  revalidatePath("/app", "layout");
  return websiteSaved ? { ok: true } : { ok: true, notice: WEBSITE_NOT_SAVED_NOTICE };
}

/**
 * Persists the wizard's optional website through the EXISTING authoritative
 * path: the `upsert_email_brand` RPC (migration 0042) that Settings → Email
 * identity uses, writing `voom_email_brands.website` — the only column Voom
 * reads a website from (Branded Email Engine: email link + default CTA
 * destination). No new schema, no second copy on `businesses`.
 *
 * Only the website key is sent: the RPC coalesces missing values, so an
 * existing logo, colours or footer line are never touched, and an empty or
 * implausible website sends nothing at all. Best-effort by design — the
 * business row is already saved, so a failure here (RPC missing, service
 * role not configured, provider-side validation) surfaces as a notice and
 * never as a failed onboarding.
 */
async function saveOnboardingWebsite(ownerId: string, raw: string | undefined): Promise<boolean> {
  const website = normalizeWebsiteUrl(raw);
  if (!website) return true;
  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc("upsert_email_brand", {
      p_owner_user_id: ownerId,
      p_payload: { website },
    });
    return !error;
  } catch {
    return false;
  }
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

/**
 * Saves the AI Media Spending settings (migration 0031).
 *
 * This is the ONLY switch that lets MARA spend provider credits without an
 * explicit request. It is owner-scoped through the existing `businesses` RLS
 * policy, and the values are normalized through the SAME pure helper the gate
 * uses, so what the owner saves is exactly what the server enforces. Manual
 * mode never spends automatically whatever this toggle says.
 */
export async function saveMediaSpendSettings(input: MediaSpendSettings): Promise<SaveResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please log in again." };

  const supabase = await createClient();
  const settings = normalizeMediaSpendSettings({
    allow_automatic_paid_media: input.allowAutomaticPaidMedia,
    monthly_media_budget_usd: input.monthlyMediaBudgetUsd,
  });
  const { error } = await supabase
    .from("businesses")
    .update({
      allow_automatic_paid_media: settings.allowAutomaticPaidMedia,
      monthly_media_budget_usd: settings.monthlyMediaBudgetUsd,
    })
    .eq("owner_user_id", user.id);
  if (error) return { ok: false, error: saveError(error) };

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
