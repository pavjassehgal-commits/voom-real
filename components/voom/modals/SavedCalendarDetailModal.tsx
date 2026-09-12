"use client";

import { useEffect, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import { isPastInstant } from "@/lib/voom/schedule-guard";
import { Btn, Tag } from "@/components/voom/ui/primitives";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "@/components/voom/ui/Modal";

interface CalendarDetail {
  title: string;
  channel: string;
  content: string;
  publishAt: string;
  status: string;
  contentType: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export function SavedCalendarDetailModal({ itemId }: { itemId: string }) {
  const { close } = useModal();
  const [item, setItem] = useState<CalendarDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/voom/calendar/${encodeURIComponent(itemId)}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json() as { item?: CalendarDetail; error?: string };
        if (!response.ok || !body.item) throw new Error(body.error ?? "That calendar item couldn't load.");
        setItem(body.item);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "That calendar item couldn't load.");
      }
    }
    void load();
    return () => controller.abort();
  }, [itemId]);

  return (
    <ModalShell>
      <ModalHead
        title={item ? <><span className="mb-2 flex flex-wrap gap-1.5">{item.contentType ? <Tag tone="t-brand">{item.contentType}</Tag> : null}<Tag tone="t-grey">{item.channel}</Tag></span><div>{item.title}</div></> : "Calendar item"}
        sub={item ? formatDateTime(item.publishAt) : "Loading final saved content…"}
        onClose={close}
      />
      <ModalBody>
        {error ? <div role="alert" className="rounded-xl border border-red/35 bg-red/10 px-3.5 py-3 text-sm text-red">{error}</div> : null}
        {!error && !item ? <div className="py-8 text-center text-sm text-text-3">Loading calendar details…</div> : null}
        {item ? <div className="space-y-4">
          <Detail label="Final caption / content"><p className="whitespace-pre-wrap text-sm leading-relaxed text-text-1">{item.content || "No content was saved."}</p></Detail>
          <div className="grid gap-3 sm:grid-cols-2">
            <Detail label="Scheduled for"><p className="text-sm font-semibold">{formatDateTime(item.publishAt)}</p></Detail>
            <Detail label="Status"><Tag tone={statusTone(item.status)}>{statusLabel(item.status)}</Tag></Detail>
          </div>
          {item.status === "scheduled" && isPastInstant(item.publishAt) && (
            <p className="rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-xs leading-relaxed text-amber">
              This item is past its scheduled time. It stays on the schedule until Voom completes it on the next
              automatic run — it is never silently dropped or published twice.
            </p>
          )}
          {item.contentType
            ? <Detail label="Content type"><p className="text-sm text-text-2">{item.contentType} · created in Voom</p></Detail>
            : item.source ? <Detail label="Source"><p className="text-sm text-text-2">{item.source}</p></Detail> : null}
          <div className="grid gap-3 border-t border-line pt-4 text-xs text-text-3 sm:grid-cols-2">
            <p><b className="text-text-2">Created</b><br />{formatDateTime(item.createdAt)}</p>
            <p><b className="text-text-2">Last updated</b><br />{formatDateTime(item.updatedAt)}</p>
          </div>
          <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-xs leading-relaxed text-text-3">This is planned content saved inside Voom. Nothing has been published or sent externally.</p>
        </div> : null}
      </ModalBody>
      <ModalFoot><Btn variant="primary" onClick={close}>Done</Btn></ModalFoot>
    </ModalShell>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <section><h3 className="mb-1.5 text-xs font-semibold text-text-2">{label}</h3>{children}</section>;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-AE", { timeZone: "Asia/Dubai", weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusLabel(status: string) {
  if (status === "approved") return "Approved inside Voom";
  if (status === "scheduled") return "Scheduled inside Voom";
  if (status === "draft") return "Draft inside Voom";
  return "Planned inside Voom";
}

function statusTone(status: string) { return status === "scheduled" ? "t-green" : status === "approved" ? "t-blue" : "t-amber"; }
