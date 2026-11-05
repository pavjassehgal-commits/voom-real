import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import Logo from "../components/Logo";
import ForgotPasswordForm from "./ForgotPasswordForm";

export default async function ForgotPasswordPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) {
    redirect("/app");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <ForgotPasswordForm />
    </div>
  );
}
