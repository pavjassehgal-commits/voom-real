"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { clearLocalAuthCookies } from "@/lib/auth/cookies";
import { loginFlow, type AuthState } from "@/lib/auth/flows";
export type LoginState = AuthState;
export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const supabase = await createClient();
  let result;
  try { result = await loginFlow(supabase.auth, formData); }
  catch {
    await clearLocalAuthCookies();
    return { formError: "Unable to sign in right now. Please wait and try again." };
  }
  if (result.destination) redirect(result.destination);
  return result.state;
}
