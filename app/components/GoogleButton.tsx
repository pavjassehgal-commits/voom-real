"use client";

import { useFormStatus } from "react-dom";
import { continueWithGoogle } from "@/app/auth/google/actions";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1C3.3 21.3 7.3 24 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3c-.5-1.5-.5-3.1 0-4.6V6.6H1.3c-1.7 3.4-1.7 7.4 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.7c1.7 0 3.3.6 4.5 1.8l3.4-3.4C17.9 1.2 15.1 0 12 0 7.3 0 3.3 2.7 1.3 6.6l4 3.1c.9-2.9 3.6-5 6.7-5z" />
    </svg>
  );
}

function Button() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-[46px] w-full items-center justify-center gap-2.5 rounded-[11px] border border-line bg-surface-2 text-sm font-semibold text-text transition hover:bg-surface disabled:opacity-60"
    >
      <GoogleMark />
      {pending ? "Opening Google…" : "Continue with Google"}
    </button>
  );
}

/**
 * The "Continue with Google" button plus an "or" divider, used above the
 * email forms on /login and /signup. Submits the shared server action.
 */
export default function GoogleButton() {
  return (
    <div className="mt-6">
      <form action={continueWithGoogle}>
        <Button />
      </form>
      <div className="my-5 flex items-center gap-3 text-xs text-text-3">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
    </div>
  );
}
