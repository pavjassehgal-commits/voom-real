import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/voom/shell/AppShell";
import { getBusinessRecord } from "@/lib/voom/server-data";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const business = await getBusinessRecord();
  if (!business || !business.onboarding_completed) {
    redirect("/app/onboarding");
  }

  return <AppShell>{children}</AppShell>;
}
