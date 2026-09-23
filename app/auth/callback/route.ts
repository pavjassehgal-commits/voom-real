import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { clearLocalAuthCookies } from "@/lib/auth/cookies";
import { verificationFlow } from "@/lib/auth/flows";

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  if (params.has("error")) redirect("/verify-email?error=invalid_link");
  const supabase = await createClient();
  let destination: string;
  try { destination = await verificationFlow(supabase.auth, params.get("code"), params.get("sb_flow_id"), params.get("next")); }
  catch {
    await clearLocalAuthCookies();
    destination = "/verify-email?error=invalid_link";
  }
  redirect(destination);
}
