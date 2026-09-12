"use client";

import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { Icon } from "../icons";
import { cx } from "./primitives";

const BORDER: Record<string, string> = {
  ok: "border-l-green",
  err: "border-l-red",
  info: "border-l-brand",
};

const ICON: Record<string, string> = { ok: "check", err: "warn", info: "info" };
const COLOR_CLASS: Record<string, string> = { ok: "text-green", err: "text-red", info: "text-brand" };

export function ToastHost() {
  const { toasts } = useVoomState();
  const { dismissToast } = useVoomActions();
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-5 right-5 z-[200] flex max-w-[calc(100vw-40px)] flex-col gap-2.5 sm:right-5 sm:left-auto left-3.5 right-3.5 bottom-[76px] sm:bottom-5">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "flex min-w-[250px] items-center gap-2.5 rounded-[13px] border border-line border-l-[3.5px] bg-surface px-4 py-3 text-[13.5px] font-medium shadow-[var(--shadow-lg)]",
            BORDER[t.kind],
          )}
        >
          <span className={cx("grid place-items-center", COLOR_CLASS[t.kind])}>
            <Icon name={ICON[t.kind]} size={17} />
          </span>
          <span>
            {t.msg}
          </span>
          <button
            className="ml-1 text-text-3 hover:text-text"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
