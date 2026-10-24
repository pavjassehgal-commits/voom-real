"use client";

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
 */
const TONE: Record<Toast["kind"], { icon: string; label: string }> = {
  ok: { icon: "checkCircle", label: "Success" },
  err: { icon: "warn", label: "Error" },
  warn: { icon: "warn", label: "Warning" },
  info: { icon: "info", label: "Notice" },
};

export function ToastHost() {
  const { toasts } = useVoomState();
  const { dismissToast } = useVoomActions();
  return (
    <div className="voom-toast-host" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "err" ? "alert" : "status"}
          className={cx("voom-toast", `voom-toast--${t.kind}`)}
        >
          <span className="voom-toast__icon" aria-hidden="true">
            <Icon name={TONE[t.kind].icon} size={17} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="sr-only">{TONE[t.kind].label}: </span>
            {t.msg}
          </span>
          <button className="voom-toast__close" onClick={() => dismissToast(t.id)} aria-label="Dismiss notification">
            <Icon name="x" size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
