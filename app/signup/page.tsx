import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import SignupForm from "./SignupForm";

export default async function SignupPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) {
    redirect("/app");
  }

  return <SignupForm googleEnabled={process.env.VOOM_GOOGLE_AUTH_ENABLED === "true"} />;
}
