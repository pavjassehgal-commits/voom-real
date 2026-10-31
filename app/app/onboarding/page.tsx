import { redirect } from "next/navigation";
import { OnboardingWizard } from "@/components/voom/onboarding/OnboardingWizard";
import { isAiVisionConfigured } from "@/lib/ai";
import { getBusinessRecord } from "@/lib/voom/server-data";

// The website read (slice 7: text fetch plus a headless-browser screenshot) runs as a
// server action from this page and can take longer than the platform default.
export const maxDuration = 60;

// Merge note (2026-11-01): main's redesigned wizard dropped this redirect and passes
// `completedOnServer` so its "Your workspace is ready" summary can show after the save
// revalidates /app. Our 11-screen wizard (Brand Kit v2) is kept as is; adopting their
// SetupComplete screen and that pattern is Phase C of handover/merge-plan.md.
export default async function OnboardingPage() {
  const business = await getBusinessRecord();
  if (business?.onboarding_completed) {
    redirect("/app");
  }

  return <OnboardingWizard visionEnabled={isAiVisionConfigured()} />;
}
