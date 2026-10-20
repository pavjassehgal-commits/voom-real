import { createClient } from "@/utils/supabase/server";
import Logo from "../components/Logo";
import ResetPasswordForm from "./ResetPasswordForm";

export const dynamic = "force-dynamic";

/**
 * Lands here from the emailed reset link via /auth/callback?next=/reset-password.
 * The callback has already exchanged the link's code for a recovery session;
 * without one (expired, used, or opened in another browser) there is nothing
 * to update, so the page explains that and offers a new link instead.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const linkInvalid = error === "link_invalid" || !data?.claims;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <ResetPasswordForm linkInvalid={linkInvalid} />
    </div>
  );
}
