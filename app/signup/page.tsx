import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/server";
import { isVerifiedUser } from "@/lib/auth/policy";
import Logo from "../components/Logo";
import SignupForm from "./SignupForm";

export default async function SignupPage() {
  const user = await getAuthUser();
  if (isVerifiedUser(user)) {
    redirect("/app");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <SignupForm />
    </div>
  );
}
