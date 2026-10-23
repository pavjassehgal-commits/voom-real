"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Icon } from "@/components/voom/icons";
import { AUTH_INPUT, AUTH_SUBMIT, AuthAlert, AuthField, PasswordToggle } from "@/components/voom/auth/AuthFrame";
import { login, type LoginState } from "./actions";

const initialState: LoginState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={AUTH_SUBMIT}>
      {pending ? "Logging in…" : <>Log in <Icon name="arrow" size={15} /></>}
    </button>
  );
}

/**
 * Email + password log in through the existing `login` server action. The
 * reference's Google / Apple buttons, "Keep me logged in" and "Forgot
 * password?" are not shown: Voom has no social sign-in or password-reset flow
 * yet, and a dead control would be worse than none.
 */
export default function LoginForm({ initialError }: { initialError?: string }) {
  const [state, formAction] = useActionState(login, initialState);
  const [showPassword, setShowPassword] = useState(false);
  const formError = state.formError ?? initialError;

  return (
    <>
      <form action={formAction} className="mt-7 flex flex-col gap-4">
        {formError && <AuthAlert>{formError}</AuthAlert>}

        <AuthField label="Email" icon="mail" error={state.fieldErrors?.email} errorId="email-error">
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@business.com"
            aria-invalid={state.fieldErrors?.email ? "true" : undefined}
            aria-describedby={state.fieldErrors?.email ? "email-error" : undefined}
            className={AUTH_INPUT}
          />
        </AuthField>

        <AuthField label="Password" icon="lock" error={state.fieldErrors?.password} errorId="password-error">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            required
            autoComplete="current-password"
            placeholder="••••••••"
            aria-invalid={state.fieldErrors?.password ? "true" : undefined}
            aria-describedby={state.fieldErrors?.password ? "password-error" : undefined}
            className={`${AUTH_INPUT} !pr-11`}
          />
          <PasswordToggle shown={showPassword} onToggle={() => setShowPassword((value) => !value)} />
        </AuthField>

        <SubmitButton />
      </form>

      <p className="mt-7 text-center text-[13px] text-text-2">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-semibold text-[var(--brand)] hover:underline">
          Create account
        </Link>
      </p>
    </>
  );
}
