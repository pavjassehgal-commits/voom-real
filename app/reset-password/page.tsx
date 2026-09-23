import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readRecoveryCode, RECOVERY_COOKIE } from "@/lib/auth/recovery";
import AuthCard from "../auth/AuthCard";
import ResetForm from "./ResetForm";
export default async function ResetPassword() {
  if (!readRecoveryCode((await cookies()).get(RECOVERY_COOKIE)?.value)) redirect("/forgot-password?error=invalid_link");
  return <AuthCard title="Choose a new password"><ResetForm /></AuthCard>;
}
