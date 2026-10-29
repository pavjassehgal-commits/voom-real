import { redirect } from "next/navigation";
import { OnboardingWizard } from "@/components/voom/onboarding/OnboardingWizard";
import { isAiVisionConfigured } from "@/lib/ai";
import { getBusinessRecord } from "@/lib/voom/server-data";

// The website read (slice 7: text fetch plus a headless-browser screenshot) runs as a
// server action from this page and can take longer than the platform default.
export const maxDuration = 60;

export default async function OnboardingPage() {
  const business = await getBusinessRecord();
  if (business?.onboarding_completed) {
    redirect("/app");
  }

  return <OnboardingWizard visionEnabled={isAiVisionConfigured()} />;
}
