"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import GoogleButton from "../components/GoogleButton";
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
 * Email + password log in through the existing `login` server action, plus
 * "Continue with Google" (Supabase OAuth, `app/auth/google/actions.ts`) and the
 * "Forgot password?" link to the reset flow; both exist since 2026-10-20. The
 * reference's Apple button and "Keep me logged in" are not shown: Voom has
 * neither, and a dead control would be worse than none.
 */
export default function LoginForm({
  initialError,
  initialNotice,
}: {
  initialError?: string;
  initialNotice?: string;
}) {
  const [state, formAction] = useActionState(login, initialState);
  const [showPassword, setShowPassword] = useState(false);
  const formError = state.formError ?? initialError;
  // A good-news notice (e.g. "password updated") stays until the form reports something.
  const notice = state.formError || state.fieldErrors ? undefined : initialNotice;

  return (
    <>
      <GoogleButton />

      <form action={formAction} className="flex flex-col gap-4">
        {notice && (
          <p
            role="status"
            className="rounded-[10px] border border-[var(--green-soft)] bg-[var(--green-soft)] px-3.5 py-2.5 text-[13px] text-[var(--green)]"
          >
            {notice}
          </p>
        )}
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

      <p className="mt-5 text-center text-[13px] text-text-2">
        <Link href="/forgot-password" className="font-semibold text-[var(--brand)] hover:underline">
          Forgot password?
        </Link>
      </p>

      <p className="mt-3 text-center text-[13px] text-text-2">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-semibold text-[var(--brand)] hover:underline">
          Create account
        </Link>
      </p>
    </>
  );
}
