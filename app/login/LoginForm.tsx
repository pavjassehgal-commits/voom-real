"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { login, type LoginState } from "./actions";

const initialState: LoginState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="voom-grad mt-1 inline-flex h-[46px] w-full items-center justify-center rounded-[11px] text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
    >
      {pending ? "Logging in…" : "Log in"}
    </button>
  );
}

export default function LoginForm({ initialError }: { initialError?: string }) {
  const [state, formAction] = useActionState(login, initialState);
  const formError = state.formError ?? initialError;

  return (
    <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(0,0,0,.5),0_12px_32px_-16px_rgba(0,0,0,.8)]">
      <h1 className="font-display text-xl font-semibold tracking-tight">
        Log in to Voom
      </h1>
      <p className="mt-1 text-sm text-text-2">
        MARA has been keeping an eye on things.
      </p>

      <form action={formAction} className="mt-6 flex flex-col gap-4">
        {formError && (
          <p
            role="alert"
            className="rounded-xl border border-red-900/40 bg-red-950/30 px-3.5 py-2.5 text-sm text-red-300"
          >
            {formError}
          </p>
        )}

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-text-2">
            Email
          </span>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@business.com"
            aria-invalid={state.fieldErrors?.email ? "true" : undefined}
            aria-describedby={
              state.fieldErrors?.email ? "email-error" : undefined
            }
            className="h-11 w-full rounded-xl border border-line bg-surface-2 px-3.5 text-sm text-text placeholder:text-text-3 focus:border-brand focus:outline-none focus:ring-4 focus:ring-[var(--brand-soft)]"
          />
          {state.fieldErrors?.email && (
            <p id="email-error" role="alert" className="mt-1.5 text-xs text-red-400">
              {state.fieldErrors.email}
            </p>
          )}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-text-2">
            Password
          </span>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••"
            aria-invalid={state.fieldErrors?.password ? "true" : undefined}
            aria-describedby={
              state.fieldErrors?.password ? "password-error" : undefined
            }
            className="h-11 w-full rounded-xl border border-line bg-surface-2 px-3.5 text-sm text-text placeholder:text-text-3 focus:border-brand focus:outline-none focus:ring-4 focus:ring-[var(--brand-soft)]"
          />
          {state.fieldErrors?.password && (
            <p id="password-error" role="alert" className="mt-1.5 text-xs text-red-400">
              {state.fieldErrors.password}
            </p>
          )}
        </label>

        <SubmitButton />
      </form>

      <p className="mt-6 text-center text-xs text-text-3">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-medium text-text-2 hover:text-text">
          Sign up
        </Link>
      </p>
    </div>
  );
}
