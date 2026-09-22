"use client";
import { useActionState, useEffect, useState } from "react";
import { forgotPassword, resendVerification } from "./actions";
import type { AuthState } from "@/lib/auth/flows";

export default function EmailForm({ kind }: { kind: "signup" | "recovery" }) {
  const [state, action, pending] = useActionState(kind === "signup" ? resendVerification : forgotPassword, {} as AuthState);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!state.retryAfter) return;
    const until = Date.now() + state.retryAfter * 1000;
    const timer = setInterval(() => setSeconds(Math.max(0, Math.ceil((until - Date.now()) / 1000))), 250);
    return () => clearInterval(timer);
  }, [state]);
  return <form action={action} className="space-y-4">
    {state.message && <p role="status" className="rounded-xl border border-line bg-surface-2 p-3">{state.message}</p>}
    <label className="block"><span className="mb-2 block font-medium">Email address</span>
      <input name="email" type="email" autoComplete="email" required maxLength={254} aria-invalid={Boolean(state.fieldErrors?.email)} aria-describedby={state.fieldErrors?.email ? "email-error" : undefined}
        className="h-12 w-full rounded-xl border border-line bg-surface-2 px-3 text-text focus:outline-none focus:ring-2 focus:ring-brand" />
    </label>
    {state.fieldErrors?.email && <p id="email-error" role="alert" className="text-red-300">{state.fieldErrors.email}</p>}
    <button disabled={pending || seconds > 0} className="voom-grad min-h-12 w-full rounded-xl px-4 font-semibold text-white disabled:opacity-60">
      {pending ? "Please wait…" : seconds > 0 ? `Try again in ${seconds}s` : kind === "signup" ? "Resend verification email" : "Send reset link"}
    </button>
  </form>;
}
