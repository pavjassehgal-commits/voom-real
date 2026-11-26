"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useReducer, useRef, useState, type Dispatch, type ReactNode } from "react";
import { automationPauseUiReducer, type AutomationPauseSnapshot, type AutomationPauseUiAction, type AutomationPauseUiState } from "@/lib/voom/automation-pause-ui";
import { Icon } from "@/components/voom/icons";
import { BTN, StatCard } from "@/components/voom/redesign/ui";
import { cx } from "@/lib/voom/cx";

const PauseContext = createContext<{ state: AutomationPauseUiState; dispatch: Dispatch<AutomationPauseUiAction> } | null>(null);

export function AutomationPauseProvider({ initialState, children }: { initialState: AutomationPauseSnapshot; children: ReactNode }) {
  const [state, dispatch] = useReducer(automationPauseUiReducer, { snapshot: initialState, notice: null });
  useEffect(() => { dispatch({ type: "server", snapshot: initialState }); }, [initialState]);
  return <PauseContext.Provider value={{ state, dispatch }}>{children}</PauseContext.Provider>;
}

function usePauseState() {
  const value = useContext(PauseContext);
  if (!value) throw new Error("Automation pause controls require their provider.");
  return value;
}

export function AutomationPauseBanner({ timeZone }: { timeZone: string }) {
  const { state } = usePauseState();
  if (!state.snapshot) return <p role="status" className="mb-5 text-[13.5px] text-text-3">Pause state unavailable — refresh to retry.</p>;
  const pausedAt = state.snapshot.pausedAt;
  if (!pausedAt && !state.notice) return null;
  return <div role="status" className={cx("mb-5 flex gap-3 rounded-[18px] border px-5 py-4 text-[14.5px]", pausedAt ? "border-[var(--coral)]/25 bg-[var(--coral-soft)] text-text" : "border-[var(--green)]/25 bg-[var(--green-soft)] text-[var(--green)]")}>
    <Icon name={pausedAt ? "warn" : "checkCircle"} size={18} className="mt-0.5 shrink-0" />
    <span>{state.notice?.text ?? <><b className="font-semibold text-[var(--coral)]">Automation is paused</b> since {new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(pausedAt!))}. MARA isn’t starting new automatic work. Cancelled posts require a fresh explicit owner approval; paused email flows must be restarted individually.</>}</span>
  </div>;
}

export function AutomationPauseModeCard({ confirmed, value }: { confirmed: boolean; value: string }) {
  const { state } = usePauseState();
  return <StatCard icon="sparkle" value={value} label={!state.snapshot ? "Pause state unavailable" : state.snapshot.pausedAt ? "Saved mode · paused" : confirmed ? "Current mode" : "Not confirmed yet"} tone="brand" />;
}

/**
 * Pause all / Resume through the existing server APIs (`/api/automation/pause`
 * and `/api/automation/resume`). Both ask for confirmation first and say
 * exactly what the server does; resume sends `confirm: true`, which the
 * route requires. Each request carries a fresh idempotency key, so a retry
 * after a network failure is safe.
 */
export function AutomationPauseControl() {
  const { state, dispatch } = usePauseState();
  const pausedAt = state.snapshot?.pausedAt;
  const router = useRouter();
  const [dialog, setDialog] = useState<"pause" | "resume" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  async function submit(kind: "pause" | "resume") {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/automation/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "resume" ? { idempotencyKey: crypto.randomUUID(), confirm: true } : { idempotencyKey: crypto.randomUUID() }),
      });
      const body = await response.json() as {
        error?: string; message?: string; pauseState?: AutomationPauseSnapshot;
        socialJobsStopped?: { instagram: number; youtube: number; tiktok: number };
        lifecycleFlowsPaused?: number;
      };
      if (!response.ok) throw new Error(body.error ?? "Voom couldn't complete that safely. Please retry.");
      // A mutation acknowledgement alone is not the current pause state.
      // Use the fresh server snapshot; unknown state must never guess running.
      const snapshot = body.pauseState ?? null;
      if (!snapshot) {
        dispatch({ type: "server", snapshot: null });
        throw new Error("The request completed, but the current pause state could not be verified. Refresh before trying again.");
      }
      let text: string;
      if (kind === "pause" && body.socialJobsStopped) {
        const stopped = body.socialJobsStopped.instagram + body.socialJobsStopped.youtube + body.socialJobsStopped.tiktok;
        text = `Automation paused. ${stopped} unclaimed Autopilot post${stopped === 1 ? "" : "s"} cancelled and ${body.lifecycleFlowsPaused ?? 0} email flow${body.lifecycleFlowsPaused === 1 ? "" : "s"} paused. Your own approved posts and anything already sent to a platform are unchanged.`;
      } else {
        text = body.message ?? (kind === "pause" ? "Automation paused." : "Automation resumed.");
      }
      dispatch({ type: "confirmed", snapshot, paused: kind === "pause", text });
      setDialog(null);
      window.dispatchEvent(new Event("voom:data-changed"));
      router.refresh();
    } catch (reason) {
      dispatch({ type: "server", snapshot: null });
      router.refresh();
      setError(reason instanceof Error ? reason.message : "Voom couldn't complete that safely. Please retry.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      {!state.snapshot ? <span className="text-[13.5px] text-text-3">Pause state unavailable</span> : pausedAt
        ? <button type="button" className={BTN.primary} disabled={busy} onClick={() => { setError(""); setDialog("resume"); }}><Icon name="play" size={14} /> Resume automation</button>
        : <button type="button" className={cx(BTN.outline, "border-[var(--coral)]/40 text-[var(--coral)] hover:bg-[var(--coral-soft)]")} disabled={busy} onClick={() => { setError(""); setDialog("pause"); }}><Icon name="x" size={14} /> Pause all</button>}
      {dialog && (
        <div className="fixed inset-0 z-[95] grid place-items-center bg-[rgba(26,31,48,0.35)] p-4 backdrop-blur-[3px]" role="dialog" aria-modal="true" aria-labelledby="pause-dialog-title">
          <div className="w-full max-w-[480px] rounded-[24px] bg-surface p-6 shadow-[var(--shadow-lg)]">
            <h2 id="pause-dialog-title" className="text-[20px] font-bold tracking-[-0.02em] text-text">{dialog === "pause" ? "Pause all automation?" : "Resume automation?"}</h2>
            {dialog === "pause" ? (
              <ul className="mt-3 space-y-2 text-[14px] leading-relaxed text-text-2">
                <li>• MARA stops starting new automatic work.</li>
                <li>• Autopilot posts that haven’t been picked up for publishing are cancelled.</li>
                <li>• Active email flows are paused.</li>
                <li>• Posts you approved yourself, and anything already sent to a platform, are not touched.</li>
              </ul>
            ) : (
              <ul className="mt-3 space-y-2 text-[14px] leading-relaxed text-text-2">
                <li>• MARA can start new automatic work again, within your mode and plan.</li>
                <li>• Posts cancelled by the pause are <b className="text-text">not</b> restored. Open the platform editor, review the latest content and explicitly approve again. Changing the time alone cannot resume publishing.</li>
                <li>• Paused email flows stay paused until you restart each one.</li>
              </ul>
            )}
            {error && <p role="alert" className="mt-3 rounded-[12px] bg-[var(--red-soft)] px-3 py-2 text-[13.5px] text-[var(--red)]">{error}</p>}
            <div className="mt-5 flex justify-end gap-2.5">
              <button type="button" className={cx(BTN.quiet, "rounded-full")} disabled={busy} onClick={() => setDialog(null)}>Cancel</button>
              <button type="button" className={BTN.primary} disabled={busy} onClick={() => void submit(dialog)}>
                {busy ? "Working…" : dialog === "pause" ? "Pause all automation" : "Yes, resume automation"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
