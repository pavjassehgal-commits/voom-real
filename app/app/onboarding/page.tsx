import { OnboardingWizard } from "@/components/voom/onboarding/OnboardingWizard";
import { isAiVisionConfigured } from "@/lib/ai";
import { getBusinessRecord } from "@/lib/voom/server-data";

// The website read (slice 7: text fetch plus a headless-browser screenshot) runs as a
// server action from this page and can take longer than the platform default.
export const maxDuration = 60;

/**
 * Setup. A finished account opening this page is sent on to the app by the
 * wizard itself (see `completedOnServer`), not by a server redirect here:
 * saving setup revalidates /app, which re-renders this page inside the save
 * action's own response — a server redirect at that moment would throw the
 * owner to Today before the "Your workspace is ready" summary could show
 * (main's pattern, adopted in Phase C of handover/merge-plan.md, 2026-11-02).
 */
export default async function OnboardingPage() {
  const business = await getBusinessRecord();
  return <OnboardingWizard visionEnabled={isAiVisionConfigured()} completedOnServer={Boolean(business?.onboarding_completed)} />;
}
