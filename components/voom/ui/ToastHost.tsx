"use client";

import { useEffect } from "react";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import type { Toast } from "@/lib/voom/types";
import { Icon } from "../icons";
import { cx } from "./primitives";

/**
 * App-wide notifications.
 *
 * The host is mounted in Providers, OUTSIDE the `.voom-shell` / `.voom-public`
 * token scopes, so it carries its own `.voom-toast-host` tokens (app/globals.css):
 * light by default, dark only inside the dark workspace — never on the
 * light-only setup and public screens. Text never inherits a page colour.
 *
 * Placement keeps essential buttons clear: above the mobile bottom bar in the
 * workspace, and above any sticky action footer that opts in with
 * `data-toast-clearance` (setup's Back / Continue).
 *
 * Stacking: the store coalesces identical messages into one toast with a
 * repeat count. At most MAX_VISIBLE show at once, oldest first; the rest wait
 * (counted in a "more" line) and appear as earlier ones leave. A toast's
 * expiry starts only when it is visible, and restarts when it repeats, so no
 * distinct message expires unseen.
 */
export const MAX_VISIBLE_TOASTS = 3;
export const TOAST_DURATION_MS = 3000;

const TONE: Record<Toast["kind"], { icon: string; label: string }> = {
  ok: { icon: "checkCircle", label: "Success" },
  err: { icon: "warn", label: "Error" },
  warn: { icon: "warn", label: "Warning" },
  info: { icon: "info", label: "Notice" },
};

export function ToastHost() {
  const { toasts } = useVoomState();
  const { dismissToast } = useVoomActions();
  const visible = toasts.slice(0, MAX_VISIBLE_TOASTS);
  const waiting = toasts.length - visible.length;
  return (
    <div className="voom-toast-host" aria-live="polite" aria-relevant="additions">
      {visible.map((t) => (
        // Keyed by seq: a repeat remounts the toast, which restarts its expiry
        // and lets assistive technology announce the repeated message again.
        <ToastItem key={`${t.id}:${t.seq}`} toast={t} onDismiss={dismissToast} />
      ))}
      {waiting > 0 && (
        <p className="voom-toast-more">{waiting} more notification{waiting === 1 ? "" : "s"}</p>
      )}
    </div>
  );
}

function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(t.id), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [t.id, t.seq, onDismiss]);

  return (
    <div role={t.kind === "err" ? "alert" : "status"} className={cx("voom-toast", `voom-toast--${t.kind}`)}>
      <span className="voom-toast__icon" aria-hidden="true">
        <Icon name={TONE[t.kind].icon} size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="sr-only">{TONE[t.kind].label}: </span>
        {t.msg}
        {t.count > 1 && <span className="sr-only"> (shown {t.count} times)</span>}
      </span>
      {t.count > 1 && <span className="voom-toast__count" aria-hidden="true">×{t.count}</span>}
      <button className="voom-toast__close" onClick={() => onDismiss(t.id)} aria-label="Dismiss notification">
        <Icon name="x" size={15} />
      </button>
    </div>
  );
}
