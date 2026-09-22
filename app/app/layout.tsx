import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/server";
import { isVerifiedUser } from "@/lib/auth/policy";
import { getBusinessRecord, getProfileRecord } from "@/lib/voom/server-data";
import { Providers } from "./Providers";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  if (!isVerifiedUser(user)) redirect("/verify-email");

  const [profile, business] = await Promise.all([getProfileRecord(), getBusinessRecord()]);

  return (
    <Providers
      initialDisplayName={profile?.display_name ?? null}
      initialEmail={user.email ?? null}
      initialBusiness={business}
    >
      {children}
    </Providers>
  );
}
