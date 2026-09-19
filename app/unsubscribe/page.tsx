"use client";

import { useEffect, useMemo, useState } from "react";

type State =
  | { phase: "working" }
  | { phase: "done"; message: string; businessName: string | null }
  | { phase: "failed"; message: string };

type Outcome =
  | { phase: "done"; message: string; businessName: string | null }
  | { phase: "failed"; message: string };

/** Talks to the API and returns the outcome; never touches React state. */
async function requestUnsubscribe(token: string): Promise<Outcome> {
  if (!token) {
    return { phase: "failed", message: "That unsubscribe link is incomplete. Reply to the email directly to manage your preferences." };
  }
  try {
    const response = await fetch("/api/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; message?: string; businessName?: string | null } | null;
    if (response.ok && body?.ok) {
      return { phase: "done", message: body.message ?? "You're unsubscribed from marketing email.", businessName: body.businessName ?? null };
    }
    return { phase: "failed", message: body?.message ?? "We couldn't process that request right now. Please reply to the email instead." };
  } catch {
    return { phase: "failed", message: "We couldn't process that request right now. Please reply to the email instead." };
  }
}

/**
 * Public unsubscribe destination (no login). The signed token in the URL is
 * the credential: it is owner- and address-scoped and can only be produced by
 * Voom for an address Voom actually emailed.
 */
export default function UnsubscribePage() {
  const token = useMemo(
    () => (typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("token") ?? ""),
    [],
  );
  const [state, setState] = useState<State>({ phase: "working" });

  useEffect(() => {
    let cancelled = false;
    void requestUnsubscribe(token).then((outcome) => {
      if (!cancelled) setState(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function retry() {
    setState({ phase: "working" });
    setState(await requestUnsubscribe(token));
  }

  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-sm" role="status" aria-live="polite">
        <h1 className="text-xl font-semibold text-text">Email preferences</h1>
        {state.phase === "working" && <p className="mt-4 text-sm text-muted">We’re confirming your unsubscribe…</p>}
        {state.phase === "done" && (
          <>
            <p className="mt-4 text-sm text-text">{state.message}</p>
            <p className="mt-3 text-xs text-muted">You won’t receive marketing email from {state.businessName ?? "this business"} again. This doesn’t affect order or account emails if you have one.</p>
          </>
        )}
        {state.phase === "failed" && (
          <>
            <p className="mt-4 text-sm text-text">{state.message}</p>
            <button type="button" onClick={() => void retry()} className="mt-5 rounded-lg border border-line px-4 py-2 text-sm font-medium text-text hover:bg-hover">
              Try again
            </button>
          </>
        )}
      </div>
    </main>
  );
}
