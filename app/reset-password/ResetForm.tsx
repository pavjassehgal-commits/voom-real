"use client";
import { useActionState } from "react";
import { resetPassword } from "../auth/actions";
import type { AuthState } from "@/lib/auth/flows";
export default function ResetForm() {
  const [state, action, pending] = useActionState(resetPassword, {} as AuthState);
  return <form action={action} className="space-y-4">
    <p>Use 12–128 characters. Choose a long, unique password you don&apos;t use elsewhere.</p>
    {state.formError && <p role="alert" className="text-red-300">{state.formError}</p>}
    {(["password", "confirmPassword"] as const).map(name => <label className="block" key={name}>
      <span className="mb-2 block font-medium">{name === "password" ? "New password" : "Confirm new password"}</span>
      <input name={name} type="password" autoComplete="new-password" required minLength={12} maxLength={128} aria-invalid={Boolean(state.fieldErrors?.[name])} aria-describedby={state.fieldErrors?.[name] ? `${name}-error` : undefined} className="h-12 w-full rounded-xl border border-line bg-surface-2 px-3 text-text focus:outline-none focus:ring-2 focus:ring-brand" />
      {state.fieldErrors?.[name] && <span id={`${name}-error`} role="alert" className="mt-2 block text-red-300">{state.fieldErrors[name]}</span>}
    </label>)}
    <button disabled={pending} className="voom-grad min-h-12 w-full rounded-xl px-4 font-semibold text-white disabled:opacity-60">{pending ? "Updating…" : "Save new password"}</button>
  </form>;
}
