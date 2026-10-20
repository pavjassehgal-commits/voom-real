"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { requestPasswordReset, type ForgotPasswordState } from "./actions";

const initialState: ForgotPasswordState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="voom-grad mt-1 inline-flex h-[46px] w-full items-center justify-center rounded-[11px] text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
    >
      {pending ? "Sending…" : "Send reset link"}
    </button>
  );
}

export default function ForgotPasswordForm() {
  const [state, formAction] = useActionState(requestPasswordReset, initialState);

  if (state.success) {
    return (
      <div
        role="status"
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7 text-center shadow-[0_1px_2px_rgba(0,0,0,.5),0_12px_32px_-16px_rgba(0,0,0,.8)]"
      >
        <div
          className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full"
          style={{ background: "var(--brand-soft)" }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--brand)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6"
          >
            <rect x="2" y="5" width="20" height="14" rx="3" />
            <path d="M3 7l9 6 9-6" />
          </svg>
        </div>
        <h1 className="font-display text-xl font-semibold tracking-tight">
          Check your email
        </h1>
        <p className="mt-2 text-sm text-text-2">
          If that email has an account, we&apos;ve sent a link to reset your
          password. The link works for one hour and only in this browser.
        </p>
        <p className="mt-6 text-xs text-text-3">
          <Link href="/login" className="hover:text-text-2">
            Back to login
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(0,0,0,.5),0_12px_32px_-16px_rgba(0,0,0,.8)]">
      <h1 className="font-display text-xl font-semibold tracking-tight">
        Reset your password
      </h1>
      <p className="mt-1 text-sm text-text-2">
        Enter your email and we&apos;ll send you a link to choose a new one.
      </p>

      <form action={formAction} className="mt-6 flex flex-col gap-4">
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

        <SubmitButton />
      </form>

      <p className="mt-6 text-center text-xs text-text-3">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-text-2 hover:text-text">
          Back to login
        </Link>
      </p>
    </div>
  );
}
