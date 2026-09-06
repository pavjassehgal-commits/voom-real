"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Card, Chip, Tag } from "@/components/voom/ui/primitives";

export interface PublishingQueueItem {
  id: string;
  draftId: string;
  title: string;
  type: string;
  account: string;
  scheduledAt: string;
  status: string;
  statusLabel: string;
  tone: "green" | "amber" | "red" | "grey";
  autoPublish: boolean;
  attempts: number;
  publishedAt: string | null;
  failureReason: string | null;
  thumbnailUrl: string | null;
}

interface QueueResponse {
  items?: PublishingQueueItem[];
  account?: string | null;
  connected?: boolean;
  canPublish?: boolean;
  missingPermission?: string | null;
  error?: string;
}

const FILTERS = ["All", "Scheduled", "Publishing", "Published", "Needs attention"] as const;

/**
 * The "these things are going to automatically post" surface, shown inside the
 * Content Calendar. Truthful: nothing is labelled Published unless Instagram
 * confirmed a media id.
 */
export function PublishingQueue() {
  const [state, setState] = useState<QueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/instagram/publishing-queue", { cache: "no-store" });
      const body = (await response.json()) as QueueResponse;
      if (!response.ok) throw new Error(body.error || "The publishing queue couldn't load.");
      setState(body);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The publishing queue couldn't load.");
    }
  }, []);

  useEffect(() => {
    // Deferred so the initial paint never triggers a synchronous setState.
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("voom:data-changed", refresh);
    return () => window.removeEventListener("voom:data-changed", refresh);
  }, [load]);

  const items = useMemo(() => {
    const all = state?.items ?? [];
    if (filter === "All") return all;
    if (filter === "Needs attention") return all.filter((item) => item.tone === "red");
    if (filter === "Scheduled") return all.filter((item) => item.status === "scheduled" || item.status === "waiting_for_media");
    if (filter === "Publishing") return all.filter((item) => item.status === "publishing");
    return all.filter((item) => item.status === "published");
  }, [state, filter]);

  const upcoming = (state?.items ?? []).filter((item) => item.autoPublish).length;

  return (
    <Card className="mb-3.5 p-4">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-lg">Instagram publishing queue</h2>
          <p className="text-xs text-text-3">
            {upcoming > 0
              ? `${upcoming} item${upcoming === 1 ? "" : "s"} will be published to Instagram automatically by Voom — you don't need to post them yourself.`
              : "Approve an Instagram Post or Reel and give it a date to have Voom publish it automatically."}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((value) => (
            <Chip key={value} active={filter === value} onClick={() => setFilter(value)}>{value}</Chip>
          ))}
        </div>
      </div>

      {error ? <div role="alert" className="mb-2.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div> : null}

      {state && state.missingPermission ? (
        <div role="alert" className="mb-2.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">
          Instagram publishing permission required. The connected account is missing <b>{state.missingPermission}</b>. Reconnect Instagram after the permission is approved on the Meta app — Voom will not publish until then.
        </div>
      ) : null}

      {state && !state.connected ? (
        <div className="mb-2.5 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-sm text-text-2">
          Instagram is not connected, so nothing can be auto-published yet.
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-3">Nothing in this view.</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2.5">
              <div className="h-11 w-11 flex-none overflow-hidden rounded-lg bg-surface-2">
                {item.thumbnailUrl ? (
                  <Image src={item.thumbnailUrl} alt="" width={44} height={44} unoptimized className="h-11 w-11 object-cover" />
                ) : (
                  <span className="grid h-11 w-11 place-items-center text-[10px] text-text-3">{item.type === "Reel" ? "Reel" : "Post"}</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Tag tone="t-brand">{item.type}</Tag>
                  <span className="truncate text-sm font-semibold">{item.title}</span>
                </div>
                <p className="text-xs text-text-3">
                  {item.account} · {formatDateTime(item.scheduledAt)}
                  {item.autoPublish ? " · Voom will auto-publish" : ""}
                </p>
                {item.tone === "red" && item.failureReason ? (
                  <p className="mt-0.5 text-xs text-red">{item.failureReason}{item.attempts ? ` (attempt ${item.attempts})` : ""}</p>
                ) : null}
                {item.status === "published" && item.publishedAt ? (
                  <p className="mt-0.5 text-xs text-text-3">Published to Instagram on {formatDateTime(item.publishedAt)}</p>
                ) : null}
              </div>
              <Tag tone={toneClass(item.tone)}>{item.status === "permission_required" ? "Needs attention" : item.statusLabel}</Tag>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function toneClass(tone: PublishingQueueItem["tone"]) {
  return tone === "green" ? "t-green" : tone === "amber" ? "t-amber" : tone === "red" ? "t-red" : "t-grey";
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-AE", {
    timeZone: "Asia/Dubai", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}
