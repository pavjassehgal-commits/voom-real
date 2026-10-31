"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/voom/icons";
import { BTN } from "@/components/voom/redesign/ui";
import { cx } from "@/lib/voom/cx";

/**
 * Pause all / Resume through the existing server APIs (`/api/automation/pause`
 * and `/api/automation/resume`). Both ask for confirmation first and say
 * exactly what the server does; resume sends `confirm: true`, which the
 * route requires. Each request carries a fresh idempotency key, so a retry
 * after a network failure is safe.
 */
export function AutomationPauseControl({ pausedAt }: { pausedAt: string | null }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"pause" | "resume" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  async function submit(kind: "pause" | "resume") {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/automation/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "resume" ? { idempotencyKey: crypto.randomUUID(), confirm: true } : { idempotencyKey: crypto.randomUUID() }),
      });
      const body = await response.json() as {
        error?: string; message?: string;
        socialJobsStopped?: { instagram: number; youtube: number; tiktok: number };
        lifecycleFlowsPaused?: number;
      };
      if (!response.ok) throw new Error(body.error ?? "Voom couldn't complete that safely. Please retry.");
      if (kind === "pause" && body.socialJobsStopped) {
        const stopped = body.socialJobsStopped.instagram + body.socialJobsStopped.youtube + body.socialJobsStopped.tiktok;
        setResult(`Automation paused. ${stopped} unclaimed Autopilot post${stopped === 1 ? "" : "s"} cancelled and ${body.lifecycleFlowsPaused ?? 0} email flow${body.lifecycleFlowsPaused === 1 ? "" : "s"} paused. Your own approved posts and anything already sent to a platform are unchanged.`);
      } else {
        setResult(body.message ?? "Automation resumed.");
      }
      setDialog(null);
      window.dispatchEvent(new Event("voom:data-changed"));
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't complete that safely. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {pausedAt
        ? <button type="button" className={BTN.primary} onClick={() => { setResult(""); setDialog("resume"); }}><Icon name="play" size={14} /> Resume automation</button>
        : <button type="button" className={cx(BTN.outline, "border-[var(--coral)]/40 text-[var(--coral)] hover:bg-[var(--coral-soft)]")} onClick={() => { setResult(""); setDialog("pause"); }}><Icon name="x" size={14} /> Pause all</button>}
      {result && <p role="status" className="basis-full rounded-[14px] bg-[var(--green-soft)] px-4 py-3 text-[13.5px] text-[var(--green)]">{result}</p>}
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
                <li>• Posts cancelled by the pause are <b className="text-text">not</b> restored — reschedule them yourself.</li>
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
