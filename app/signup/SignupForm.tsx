"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Icon } from "@/components/voom/icons";
import { AUTH_INPUT, AUTH_SUBMIT, AuthAlert, AuthField, AuthFrame, PasswordToggle } from "@/components/voom/auth/AuthFrame";
import { signup, type SignupState } from "./actions";

const initialState: SignupState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={AUTH_SUBMIT}>
      {pending ? "Creating account…" : <>Create account <Icon name="arrow" size={15} /></>}
    </button>
  );
}

/**
 * A guide only: the server action enforces the real rule (8+ characters).
 * Each satisfied check fills one of the four segments.
 */
function passwordStrength(password: string) {
  if (!password) return null;
  const score = [password.length >= 8, /[a-z]/.test(password) && /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length;
  const label = password.length < 8 ? "Too short — use at least 8 characters" : score >= 4 ? "Strong password" : score === 3 ? "Good password" : "Weak password";
  return { score: password.length < 8 ? Math.min(score, 1) : score, label, ok: password.length >= 8 && score >= 3 };
}

/**
 * Sign up through the existing `signup` server action (email, password and
 * the confirmation it validates). The reference's Google / Apple buttons and
 * its "Resend link" are not shown: Voom has neither flow. Agreement to the
 * Terms and Privacy Policy is stated plainly instead of a checkbox the
 * server would not record.
 */
export default function SignupForm() {
  const [state, formAction] = useActionState(signup, initialState);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const strength = passwordStrength(password);

  if (state.success) {
    return (
      <AuthFrame title="Check your email" badge={<span className="grid h-12 w-12 place-items-center rounded-full bg-[#e7f6f1] text-[var(--green)]"><Icon name="mail" size={20} /></span>}>
        <div role="status" className="mt-2 text-center">
          <p className="text-[13.5px] leading-relaxed text-text-2">
            We sent a confirmation link to {email ? <b className="font-semibold text-text">{email}</b> : "your inbox"}. Click it to activate your account and sign in.
          </p>
          <p className="mt-5 rounded-[10px] border border-[var(--line)] bg-[var(--surface-2)] px-4 py-3 text-left text-[12.5px] leading-relaxed text-text-2">
            Didn&apos;t get it? Check spam, or make sure this is the email you signed up with.
          </p>
          <button type="button" onClick={() => window.location.reload()} className="mx-auto mt-5 block text-[13px] font-semibold text-[var(--brand-ink)] hover:underline">Use a different email</button>
          <Link href="/login" className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--brand)] hover:underline">
            <Icon name="back" size={14} /> Back to log in
          </Link>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Create your account" subtitle="Start on the Free plan · no credit card">
      <form action={formAction} className="mt-6 flex flex-col gap-4">
        {state.formError && <AuthAlert>{state.formError}</AuthAlert>}

        <AuthField label="Work email" icon="mail" error={state.fieldErrors?.email} errorId="email-error">
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@business.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={state.fieldErrors?.email ? "true" : undefined}
            aria-describedby={state.fieldErrors?.email ? "email-error" : undefined}
            className={AUTH_INPUT}
          />
        </AuthField>

        <div>
          <AuthField label="Password" icon="lock" error={state.fieldErrors?.password} errorId="password-error">
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={state.fieldErrors?.password ? "true" : undefined}
              aria-describedby={[state.fieldErrors?.password ? "password-error" : "", strength ? "password-strength" : ""].filter(Boolean).join(" ") || undefined}
              className={`${AUTH_INPUT} !pr-11`}
            />
            <PasswordToggle shown={showPassword} onToggle={() => setShowPassword((value) => !value)} />
          </AuthField>
          {strength && (
            <div className="mt-2.5">
              <div className="grid grid-cols-4 gap-1.5" aria-hidden="true">
                {[0, 1, 2, 3].map((step) => (
                  <span key={step} className={`h-1 rounded-full ${step < strength.score ? (strength.ok ? "bg-[var(--green-dot)]" : "bg-[var(--amber)]") : "bg-[var(--surface-3)]"}`} />
                ))}
              </div>
              <p id="password-strength" className={`mt-1.5 text-[12px] font-medium ${strength.ok ? "text-[var(--green)]" : "text-[var(--amber)]"}`}>{strength.label}</p>
            </div>
          )}
        </div>

        <AuthField label="Confirm password" icon="lock" error={state.fieldErrors?.confirmPassword} errorId="confirm-password-error">
          <input
            id="confirmPassword"
            name="confirmPassword"
            type={showPassword ? "text" : "password"}
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="Re-enter your password"
            aria-invalid={state.fieldErrors?.confirmPassword ? "true" : undefined}
            aria-describedby={state.fieldErrors?.confirmPassword ? "confirm-password-error" : undefined}
            className={AUTH_INPUT}
          />
        </AuthField>

        <p className="text-[12.5px] leading-relaxed text-text-2">
          By creating an account you agree to the{" "}
          <Link href="/terms" className="font-semibold text-[var(--brand)] hover:underline">Terms of Service</Link> and{" "}
          <Link href="/privacy" className="font-semibold text-[var(--brand)] hover:underline">Privacy Policy</Link>.
        </p>

        <SubmitButton />
      </form>

      <p className="mt-7 text-center text-[13px] text-text-2">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-[var(--brand)] hover:underline">
          Log in
        </Link>
      </p>
    </AuthFrame>
  );
}
