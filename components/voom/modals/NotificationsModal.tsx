"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Tag } from "../ui/primitives";

interface WorkflowItem {
  draftId: string;
  concept: string;
  dayLabel: string;
  localTime: string;
  status: string;
  statusLabel: string;
}

interface WorkflowResponse {
  snapshot?: { items?: WorkflowItem[]; timeZone?: string };
  error?: string;
}

/**
 * Real notifications, derived from the one executable workflow: items that
 * need the user's approval or attention. There is no invented activity here —
 * when there is nothing to act on, the modal says so truthfully.
 */
export function NotificationsModal() {
  const { close } = useModal();
  const router = useRouter();
  const [items, setItems] = useState<WorkflowItem[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/voom/workflow", { cache: "no-store" });
      const body = await response.json() as WorkflowResponse;
      if (!response.ok || !body.snapshot) throw new Error(body.error ?? "Notifications couldn't load. Please retry.");
      const all = body.snapshot.items ?? [];
      const order: Record<string, number> = { needs_approval: 0, media_timed_out: 1, media_delayed: 2, failed: 3 };
      setItems(
        all
          .filter((item) => item.status === "needs_approval" || item.status === "failed"
            || item.status === "media_delayed" || item.status === "media_timed_out")
          .sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4)),
      );
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Notifications couldn't load. Please retry.");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function go(href: string) {
    close();
    router.push(href);
  }

  return (
    <ModalShell>
      <ModalHead title="Notifications" sub={items && items.length ? `${items.length} need${items.length === 1 ? "s" : ""} you` : "Nothing waiting"} onClose={close} />
      <ModalBody className="flex flex-col gap-2.5">
        {error && <div role="alert" className="rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>}
        {!error && items === null && <p className="py-6 text-center text-sm text-text-3">Checking what needs you…</p>}
        {!error && items && items.length === 0 && (
          <div className="py-4 text-center">
            <span className="mx-auto grid h-11 w-11 place-items-center rounded-full border border-line text-green"><Icon name="check" size={20} /></span>
            <b className="mt-2.5 block text-sm">You’re all caught up</b>
            <p className="mx-auto mt-1 max-w-[300px] text-[12.5px] leading-relaxed text-text-3">
              When a planned item needs your approval, or something stops and needs attention, it appears here and on the badge above.
            </p>
          </div>
        )}
        {items?.map((item) => {
          const failed = item.status === "failed";
          const delayed = item.status === "media_delayed";
          const timedOut = item.status === "media_timed_out";
          const mediaAttention = delayed || timedOut;
          const destination = failed ? "/app/calendar" : mediaAttention ? "/app/plan" : "/app/approvals";
          return (
            <button
              key={item.draftId}
              onClick={() => go(destination)}
              className="flex w-full items-start gap-3 rounded-2xl border border-line p-3.5 text-left transition hover:border-brand"
            >
              <span
                className={`grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] ${failed || mediaAttention ? "bg-red/10 text-red" : "bg-[var(--brand-soft)] text-brand"}`}
              >
                <Icon name={failed || mediaAttention ? "warn" : "check"} size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <b className="block text-[13.5px]">{item.concept || "Untitled item"}</b>
                <span className="mt-0.5 block text-[12.5px] text-text-2">
                  {failed
                    ? "Stopped safely — review and retry. Nothing was published twice."
                    : timedOut
                      ? "That generation ran past Voom's time limit and cannot finish, so the schedule is held. Nothing new was charged — retry it as a new generation, upload a replacement, or cancel from the Marketing Plan."
                      : delayed
                        ? "Media generation is delayed, so the schedule is held. Retry it, upload a replacement, or cancel from the Marketing Plan."
                        : "Voom is waiting for your approval before scheduling."}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Tag tone={failed || timedOut ? "t-red" : "t-amber"}>{item.statusLabel}</Tag>
                  <span className="text-[11px] text-text-3">{item.dayLabel} · {item.localTime}</span>
                </span>
              </span>
              <span className="text-text-3"><Icon name="arrow" size={16} /></span>
            </button>
          );
        })}
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>Close</Btn>
        {items && items.length > 0 && (
          <Btn variant="primary" onClick={() => go(
            items.some((item) => item.status === "failed") ? "/app/calendar"
              : items.some((item) => item.status === "media_delayed" || item.status === "media_timed_out") ? "/app/plan"
              : "/app/approvals",
          )}>
            {items.some((item) => item.status === "failed") ? "Review now"
              : items.some((item) => item.status === "media_delayed" || item.status === "media_timed_out") ? "Open Marketing Plan"
              : "Open approvals"}
          </Btn>
        )}
      </ModalFoot>
    </ModalShell>
  );
}
