import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { getBusinessRecord, getProfileRecord } from "@/lib/voom/server-data";
import { Providers } from "./Providers";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) {
    redirect("/login");
  }

  const claims = data.claims as { email?: string };
  const [profile, business] = await Promise.all([getProfileRecord(), getBusinessRecord()]);

  return (
    <Providers
      initialDisplayName={profile?.display_name ?? null}
      initialEmail={claims.email ?? null}
      initialBusiness={business}
    >
      {children}
    </Providers>
  );
}
