import { redirect } from "next/navigation";
import { OnboardingWizard } from "@/components/voom/onboarding/OnboardingWizard";
import { getBusinessRecord } from "@/lib/voom/server-data";

export default async function OnboardingPage() {
  const business = await getBusinessRecord();
  if (business?.onboarding_completed) {
    redirect("/app");
  }

  return <OnboardingWizard />;
}
