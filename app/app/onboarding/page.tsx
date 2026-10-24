import { OnboardingWizard } from "@/components/voom/onboarding/OnboardingWizard";
import { getBusinessRecord } from "@/lib/voom/server-data";

/**
 * Setup. A finished account opening this page is sent on to the app by the
 * wizard itself (see `completedOnServer`), not by a server redirect here:
 * saving setup revalidates /app, which re-renders this page inside the save
 * action's own response — a server redirect at that moment would throw the
 * owner to Today before the "Your workspace is ready" summary could show.
 */
export default async function OnboardingPage() {
  const business = await getBusinessRecord();
  return <OnboardingWizard completedOnServer={Boolean(business?.onboarding_completed)} />;
}
