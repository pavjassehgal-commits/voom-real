"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "@/components/voom/icons";
import { CreateContentModal, type CreateContentKind } from "@/components/voom/modals/CreateContentModal";
import { useModal } from "@/lib/voom/modal";
import { cx } from "@/lib/voom/cx";

const NOTICE_EVENT = "voom:today-notice-dismissed";

function noticeKey(id: string) {
  return `voom:today-notice:${id}`;
}

function readDismissed(id: string): boolean {
  try {
    return window.sessionStorage.getItem(noticeKey(id)) === "1";
  } catch {
    return false; // storage unavailable: the notice simply stays visible
  }
}

function subscribeNotices(listener: () => void) {
  window.addEventListener(NOTICE_EVENT, listener);
  return () => window.removeEventListener(NOTICE_EVENT, listener);
}

/**
 * A Today notice the user can hide for this browser session. Dismissal is a
 * presentation preference only; it never changes workflow state. Notice ids
 * include the date, so a fact that still holds is shown again the next day.
 */
export function DismissibleNotice({ id, children }: { id: string; children: ReactNode }) {
  const hidden = useSyncExternalStore(subscribeNotices, () => readDismissed(id), () => false);
  if (hidden) return null;
  return (
    <div className="relative">
      {children}
      <button
        type="button"
        onClick={() => {
          try { window.sessionStorage.setItem(noticeKey(id), "1"); } catch { /* best effort */ }
          window.dispatchEvent(new Event(NOTICE_EVENT));
        }}
        className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full text-[var(--coral)] transition hover:bg-[rgba(198,88,40,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral)] sm:right-4 sm:top-1/2 sm:-translate-y-1/2"
        aria-label="Hide this notice for today"
      >
        <Icon name="x" size={17} />
      </button>
    </div>
  );
}

const QUICK_CREATE: { kind: CreateContentKind; label: string; hint: string; icon: string; tone: string }[] = [
  { kind: "instagram_post", label: "Post", hint: "Image or text post", icon: "img", tone: "bg-surface-3 text-text-2" },
  { kind: "reel", label: "Reel", hint: "Short-form video", icon: "reel", tone: "bg-[var(--coral-soft)] text-[var(--coral)]" },
  { kind: "story", label: "Story", hint: "Quick update", icon: "story", tone: "bg-[var(--coral-soft)] text-[var(--coral)]" },
  { kind: "youtube_video", label: "Video", hint: "Long-form video", icon: "video", tone: "bg-surface-3 text-text-2" },
];

/** Quick create opens the real Create flow directly on the chosen format. */
export function QuickCreate() {
  const { open } = useModal();
  return (
    <div className="mt-3 flex flex-col gap-1">
      {QUICK_CREATE.map((entry) => (
        <button
          key={entry.kind}
          type="button"
          onClick={() => open(<CreateContentModal startStep={entry.kind} />)}
          className="flex items-center gap-3.5 rounded-[14px] px-2 py-2.5 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]"
        >
          <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-[11px]", entry.tone)}>
            <Icon name={entry.icon} size={18} />
          </span>
          <span className="min-w-0">
            <span className="block text-[14.5px] font-semibold leading-tight text-text">{entry.label}</span>
            <span className="block text-[12.5px] text-text-3">{entry.hint}</span>
          </span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => open(<CreateContentModal />)}
        className="mt-2 flex h-11 items-center gap-2.5 rounded-[14px] border border-[var(--brand-line)] bg-[var(--brand-soft-2)] px-3.5 text-[14px] font-semibold text-[var(--brand-ink)] transition hover:bg-[var(--brand-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]"
      >
        <span className="voom-create-btn grid h-6 w-6 place-items-center rounded-full text-white">
          <Icon name="sparkle" size={12} />
        </span>
        Use MARA to create
      </button>
    </div>
  );
}
