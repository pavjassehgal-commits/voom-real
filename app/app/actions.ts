"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { clearLocalAuthCookies } from "@/lib/auth/cookies";

export async function logout() {
  const supabase = await createClient();
  try { await supabase.auth.signOut({ scope: "local" }); }
  catch { /* Local credentials are still removed below; no secrets are logged. */ }
  finally { await clearLocalAuthCookies(); }
  redirect("/login");
}
