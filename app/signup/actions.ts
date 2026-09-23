"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { clearLocalAuthCookies } from "@/lib/auth/cookies";
import { signupFlow, type AuthState } from "@/lib/auth/flows";
import { authCallbackUrl } from "@/lib/auth/site";
export type SignupState = AuthState;
export async function signup(_prevState: SignupState, formData: FormData): Promise<SignupState> {
  const supabase = await createClient();
  let result;
  try { result = await signupFlow(supabase.auth, formData, authCallbackUrl("signup")); }
  catch {
    await clearLocalAuthCookies();
    return { formError: "We couldn't create your account. Please wait and try again." };
  }
  if (result.state.formError) await clearLocalAuthCookies();
  if (result.destination) redirect(result.destination);
  return result.state;
}
