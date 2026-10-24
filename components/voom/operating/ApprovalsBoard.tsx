"use client";

/* eslint-disable @next/next/no-img-element -- private signed URLs expire and must bypass the public image optimizer */

import { haptic } from "@/lib/voom/haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PostEditorModal } from "@/components/voom/modals/PostEditorModal";
import { SocialEditorModal } from "@/components/voom/modals/SocialEditorModal";
import { BTN, ChannelGlyph, StatusChip } from "@/components/voom/redesign/ui";
import { useModal } from "@/lib/voom/modal";
import { cx } from "@/lib/voom/cx";
import { Icon } from "@/components/voom/icons";
import { Btn, Input, Tag, Textarea } from "@/components/voom/ui/primitives";
import { Panel } from "@/components/voom/workspace/ui";
import { REEL_ASSET_ACCEPT, REEL_ASSET_MAX_BYTES, REEL_ASSET_PACK_LIMIT } from "@/lib/media/reel-asset";
import { formatIngestionClientError } from "@/lib/media/ingestion-error";
import { ReelCompositionPlayer } from "@/components/voom/operating/ReelCompositionPlayer";

export interface ApprovalItem { id: string; tool_name: string; summary: string; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null; status: string; result_summary: string | null; error_summary: string | null; created_at: string; updated_at?: string | null; executed_at?: string | null; }

/** Facts about the workflow draft an approval card is about (same snapshot Today and the Plan read). */
export interface ApprovalDraftFacts {
  draftId: string;
  channel: string;
  channelLabel: string;
  contentTypeLabel: string;
  status: string;
  statusLabel: string;
  hasMedia: boolean;
  mediaPreviewUrl: string | null;
  mediaMimeType: string | null;
}

type QueueTab = "review" | "retry" | "decided" | "all";
const QUEUE_TABS: { id: QueueTab; label: string }[] = [
  { id: "review", label: "Needs review" },
  { id: "retry", label: "Needs a retry" },
  { id: "decided", label: "Decided" },
  { id: "all", label: "All" },
];

/**
 * The review queue (Figma "Review what needs your decision"): a filterable
 * list of the owner's real approval cards with a detail panel. Every decision
 * is the existing `/api/mara/actions/{id}` call; when the server answers 409
 * (the draft changed, or its media is not ready) the refreshed card it returns
 * replaces the stale one and the reason stays visible — nothing is approved.
 */
export function ApprovalsBoard({ initial, drafts = {} }: { initial: ApprovalItem[]; drafts?: Record<string, ApprovalDraftFacts> }) {
  const [items, setItems] = useState(initial); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState("");
  const [notices, setNotices] = useState<Record<string, string>>({});
  async function decide(id: string, decision: "confirm" | "cancel" | "edit" | "production", changes?: Record<string, unknown>) {
    setBusy(id); setError("");
    const payload = decision === "production" ? { decision, method: changes?.method } : { decision, changes };
    const response = await fetch(`/api/mara/actions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json() as { action?: ApprovalItem; error?: string };
    if (body.action) { const action = body.action; setItems((current) => current.map((item) => item.id === id ? action : item)); window.dispatchEvent(new Event("voom:data-changed")); }
    if (response.status === 409) setNotices((current) => ({ ...current, [id]: body.error ?? "This post changed. Nothing was approved — review the latest version." }));
    else if (!response.ok || !body.action) setError(body.error ?? "Voom couldn't safely update that action.");
    else setNotices((current) => { const next = { ...current }; delete next[id]; return next; });
    haptic(response.status === 409 ? "warning" : response.ok && body.action ? "success" : "error");
    setBusy(null);
    return response.ok && Boolean(body.action);
  }
  async function produce(id: string) {
    setBusy(id); setError("");
    const response = await fetch(`/api/reels/produce/${id}`, { method: "POST" });
    const body = await response.json() as { action?: ApprovalItem; error?: string };
    if (response.ok && body.action) { setItems((current) => current.map((item) => item.id === id ? body.action! : item)); window.dispatchEvent(new Event("voom:data-changed")); }
    else setError(body.error ?? "Voom couldn't produce that Reel safely.");
    setBusy(null);
  }
  /** New video job with a fresh idempotency key (regenerate / retry). */
  async function produceVideo(id: string) {
    setBusy(id); setError("");
    const response = await fetch(`/api/reels/produce/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) });
    const body = await response.json() as { action?: ApprovalItem; error?: string };
    if (response.ok && body.action) { setItems((current) => current.map((item) => item.id === id ? body.action! : item)); window.dispatchEvent(new Event("voom:data-changed")); }
    else setError(body.error ?? "Voom couldn't start that Reel video safely.");
    setBusy(null);
  }
  // Stable identity (the reel card polls with it in an effect) and no
  // re-render churn when the server returns an unchanged action.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const refreshItem = useCallback((id: string, action: ApprovalItem) => {
    const prev = itemsRef.current.find((item) => item.id === id);
    if (prev && JSON.stringify(prev) === JSON.stringify(action)) return;
    itemsRef.current = itemsRef.current.map((item) => item.id === id ? action : item);
    setItems(itemsRef.current);
    window.dispatchEvent(new Event("voom:data-changed"));
  }, []);

  const router = useRouter();
  const { open: openModal } = useModal();
  const [tab, setTab] = useState<QueueTab>("review");
  const [channel, setChannel] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"soonest" | "newest">("soonest");
  const [selectedId, setSelectedId] = useState<string | null>(() => initial.find((item) => item.status === "pending" || item.status === "failed")?.id ?? null);

  const open = items.filter((item) => item.status === "pending" || item.status === "failed");
  const counts: Record<QueueTab, number> = {
    review: items.filter((item) => item.status === "pending").length,
    retry: items.filter((item) => item.status === "failed").length,
    decided: items.filter((item) => item.status !== "pending" && item.status !== "failed").length,
    all: items.length,
  };
  const channels = [...new Set(items.map((item) => channelOf(item, drafts)).filter(Boolean))] as string[];
  const visible = items
    .filter((item) => tab === "all" || (tab === "review" ? item.status === "pending" : tab === "retry" ? item.status === "failed" : item.status !== "pending" && item.status !== "failed"))
    .filter((item) => channel === "all" || channelOf(item, drafts) === channel)
    .filter((item) => !query.trim() || `${item.summary} ${String(item.new_value?.content ?? item.new_value?.title ?? "")}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === "newest" ? b.created_at.localeCompare(a.created_at) : publishSortKey(a).localeCompare(publishSortKey(b)));
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const selectedDraft = selected ? draftFor(selected, drafts) : null;
  const mediaBlocked = selected && selected.status === "pending" && selectedDraft && !selectedDraft.hasMedia
    ? "This post's image or video isn't ready yet. Voom approves only the complete post — confirm once its media is there."
    : undefined;
  function openEditor(draft: ApprovalDraftFacts) {
    const onChanged = () => router.refresh();
    openModal(draft.channel === "tiktok" || draft.channel === "youtube" ? <SocialEditorModal draftId={draft.draftId} onChanged={onChanged} /> : <PostEditorModal postId={draft.draftId} onChanged={onChanged} />);
  }

  return <div className="min-w-0">
    {error && <div role="alert" className="mb-4 rounded-[16px] border border-[var(--red)]/30 bg-[var(--red-soft)] px-4 py-3 text-[14px] text-[var(--red)]">{error}</div>}
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] xl:items-start">
      <section className="voom-card min-w-0 overflow-hidden" aria-label="Review queue">
        <div className="flex min-w-0 flex-col gap-3 border-b border-line p-4 sm:px-5">
          <div role="tablist" aria-label="Approval status" className="flex min-w-0 flex-wrap gap-2">
            {QUEUE_TABS.map((entry) => <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} onClick={() => setTab(entry.id)}
              className={cx("inline-flex items-center gap-2 rounded-[12px] border px-3.5 py-2 text-[14px] transition", tab === entry.id ? "border-[var(--brand-line)] bg-[var(--brand-soft-2)] font-semibold text-[var(--brand-ink)]" : "border-line text-text-2 hover:text-text")}>
              {entry.label}<span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11.5px] font-semibold text-text-2">{counts[entry.id]}</span>
            </button>)}
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <label className="relative min-w-0 flex-1 sm:max-w-[280px]"><span className="sr-only">Search approvals</span><Icon name="search" size={15} className="pointer-events-none absolute left-3.5 top-[14px] text-text-3" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search posts…" className={cx(BTN.field, "w-full pl-10")} /></label>
            <label className="sr-only" htmlFor="approvals-channel">Channel</label>
            <select id="approvals-channel" value={channel} onChange={(event) => setChannel(event.target.value)} className={BTN.field}><option value="all">All channels</option>{channels.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select>
            <label className="sr-only" htmlFor="approvals-sort">Sort</label>
            <select id="approvals-sort" value={sort} onChange={(event) => setSort(event.target.value as "soonest" | "newest")} className={BTN.field}><option value="soonest">Soonest first</option><option value="newest">Newest first</option></select>
          </div>
        </div>
        {visible.length ? <ul className="divide-y divide-line">
          {visible.map((item) => {
            const draft = draftFor(item, drafts);
            const active = item.id === selectedId;
            return <li key={item.id}>
              <button type="button" onClick={() => setSelectedId(item.id)} aria-pressed={active}
                className={cx("flex w-full min-w-0 items-center gap-3 px-4 py-3.5 text-left transition sm:px-5", active ? "bg-[var(--brand-soft-2)] shadow-[inset_3px_0_0_var(--brand)]" : "hover:bg-surface-2")}>
                <QueueThumb item={item} draft={draft} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-semibold text-text">{titleOf(item)}</span>
                  <span className="block truncate text-[12.5px] text-text-2">{draft ? `${draft.contentTypeLabel} · ${draft.channelLabel}` : String(item.new_value?.channel ?? labelForTool(item.tool_name))}</span>
                </span>
                <span className="hidden shrink-0 text-right text-[12.5px] text-text-2 sm:block">{scheduledFact(item)}</span>
                <QueueStatus item={item} draft={draft} />
              </button>
            </li>;
          })}
        </ul> : tab === "review" && !open.length ? <Panel className="m-4 py-10 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-line text-green"><Icon name="check" size={22} /></span>
          <h2 className="mt-3 font-display text-xl font-semibold tracking-[-0.02em]">You’re all caught up.</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-text-3">Nothing needs your approval. When Voom recommends a calendar change, approval, deletion, or another protected action, it will appear here first — and only then.</p>
          <p className="mx-auto mt-2 max-w-lg text-[12.5px] leading-relaxed text-text-3"><b className="text-text-2">Reel production choices live here too.</b> Generate or refresh your Marketing Plan; if MARA recommends a Reel, a “Reel production choice” card appears here so you can pick Create with MARA, upload an asset, or film it yourself.</p>
        </Panel> : <p className="px-5 py-10 text-center text-[14px] text-text-2">Nothing in this view.</p>}
        <p className="border-t border-line px-5 py-3 text-[13px] text-text-2">{visible.length} of {items.length} items</p>
      </section>

      {selected ? <aside className="voom-card min-w-0 p-4 sm:p-5" aria-label="Approval detail">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[19px] font-bold leading-tight tracking-[-0.02em] text-text">{titleOf(selected)}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-text-2">
              {selectedDraft && <><ChannelGlyph channel={selectedDraft.channel} size={18} />{selectedDraft.channelLabel} {selectedDraft.contentTypeLabel}</>}
              <QueueStatus item={selected} draft={selectedDraft} />
            </div>
          </div>
          <button type="button" onClick={() => setSelectedId(null)} aria-label="Close detail" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-text-2 hover:bg-surface-3"><Icon name="x" size={16} /></button>
        </div>
        {(selectedDraft || typeof selected.new_value?.content === "string") && <h3 className="mt-4 text-[13px] font-semibold text-text-2">Content preview</h3>}
        {!selectedDraft && typeof selected.new_value?.content === "string" && <p className="mt-1 text-[13px] text-text-3">The media preview isn’t available for this item — its post is outside the current plan horizon. The caption is shown below.</p>}
        {selectedDraft && <div className="mt-2 grid min-w-0 gap-4 sm:grid-cols-[150px_minmax(0,1fr)]">
          <div className="relative grid aspect-[4/5] place-items-center overflow-hidden rounded-[14px] bg-[linear-gradient(150deg,var(--brand-soft),var(--surface-3))] text-text-3">
            {selectedDraft.mediaPreviewUrl ? (selectedDraft.mediaMimeType?.startsWith("video") ? <video src={selectedDraft.mediaPreviewUrl} controls playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover" /> : <img src={selectedDraft.mediaPreviewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />)
              : <span className="px-3 text-center text-[12px]">{selectedDraft.hasMedia ? "Media attached" : "Awaiting media"}</span>}
          </div>
          <div className="min-w-0 text-[13.5px] leading-relaxed text-text-2">
            <p><b className="font-semibold text-text">Post status:</b> {selectedDraft.statusLabel}</p>
            {!selectedDraft.hasMedia && <p className="mt-2 rounded-[12px] bg-[var(--amber-soft)] px-3 py-2 text-[var(--amber)]">Awaiting media — Voom won’t approve this post until its image or video is ready.</p>}
            <button type="button" onClick={() => openEditor(selectedDraft)} className="mt-3 inline-flex items-center gap-2 font-semibold text-[var(--brand-ink)] hover:underline"><Icon name="pencil" size={14} /> Edit it yourself</button>
          </div>
        </div>}
        {notices[selected.id] && <p role="status" className="mt-4 rounded-[14px] border border-[var(--amber)]/30 bg-[var(--amber-soft)] px-4 py-3 text-[13.5px] text-[var(--amber)]">
          {notices[selected.id]} <button type="button" className="ml-1 font-semibold underline" onClick={() => router.refresh()}>Refresh</button>
        </p>}
        {selected.status === "pending" && selected.result_summary && !notices[selected.id] && <p className="mt-4 rounded-[14px] bg-[var(--brand-soft-2)] px-4 py-3 text-[13.5px] text-text-2">{selected.result_summary}</p>}
        <div className="mt-4">
          {selected.tool_name === "choose_reel_production"
            ? <ReelProductionCard item={selected} busy={busy === selected.id} onDecision={decide} onProduce={produce} onProduceVideo={produceVideo} onRefresh={refreshItem} />
            : <ApprovalCard item={selected} busy={busy === selected.id} onDecision={decide} confirmBlockedReason={mediaBlocked} />}
        </div>
        <section className="mt-5">
          <h3 className="text-[14px] font-semibold text-text">Activity</h3>
          <ol className="mt-3 space-y-3 text-[13px]">
            {selected.executed_at && <li className="flex gap-3"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--green)]" /><span><b className="font-semibold text-text">Decided</b> · {relativeTime(selected.executed_at)}<span className="block text-text-2">{selected.result_summary ?? selected.error_summary ?? ""}</span></span></li>}
            {selected.updated_at && selected.updated_at !== selected.created_at && !selected.executed_at && <li className="flex gap-3"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--blue)]" /><span><b className="font-semibold text-text">Updated</b> · {relativeTime(selected.updated_at)}</span></li>}
            <li className="flex gap-3"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--brand)]" /><span><b className="font-semibold text-text">MARA</b> · {relativeTime(selected.created_at)}<span className="block text-text-2">Submitted for your approval</span></span></li>
          </ol>
        </section>
      </aside> : <aside className="voom-card hidden p-6 text-center text-[14px] text-text-2 xl:block">Select an item to review it.</aside>}
    </div>
  </div>;
}

function draftFor(item: ApprovalItem, drafts: Record<string, ApprovalDraftFacts>) {
  const id = item.new_value?.sourceDraftId;
  return typeof id === "string" ? drafts[id] ?? null : null;
}
function channelOf(item: ApprovalItem, drafts: Record<string, ApprovalDraftFacts>) {
  const draft = draftFor(item, drafts);
  if (draft) return draft.channelLabel;
  const label = typeof item.new_value?.channel === "string" ? item.new_value.channel : "";
  return label.split(" ")[0] || null;
}
function titleOf(item: ApprovalItem) {
  const value = item.new_value ?? {};
  const title = typeof value.title === "string" ? value.title : typeof value.topic === "string" ? value.topic : typeof value.concept === "string" ? value.concept : "";
  return title || item.summary;
}
function publishSortKey(item: ApprovalItem) { const at = item.new_value?.publishAt; return typeof at === "string" ? at : `~${item.created_at}`; }
function labelForTool(tool: string) { return tool.includes("campaign") ? "Campaign" : tool.includes("reel") ? "Reel production" : tool.includes("calendar") ? "Calendar" : "Approval"; }
function relativeTime(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "recently";
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hours ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}
function QueueThumb({ item, draft }: { item: ApprovalItem; draft: ApprovalDraftFacts | null }) {
  return <span className="relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-[var(--brand-soft)] text-[var(--brand-ink)]">
    {draft?.mediaPreviewUrl && !draft.mediaMimeType?.startsWith("video") ? <img src={draft.mediaPreviewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <Icon name={item.tool_name === "choose_reel_production" ? "reel" : item.tool_name.includes("campaign") ? "mail" : "file"} size={16} />}
    {draft && <span className="absolute bottom-1 left-1"><ChannelGlyph channel={draft.channel} size={14} /></span>}
  </span>;
}
function QueueStatus({ item, draft }: { item: ApprovalItem; draft: ApprovalDraftFacts | null }) {
  if (item.status === "failed") return <StatusChip status="failed" label="Retry needed" small />;
  if (item.status === "pending") return draft && !draft.hasMedia ? <StatusChip status="waiting_for_media" label="Awaiting media" small /> : <StatusChip status="needs_approval" label="In review" small />;
  if (item.status === "cancelled") return <StatusChip status="draft" label="Cancelled" small />;
  if (item.status === "confirmed") return <StatusChip status="published" label={item.result_summary?.startsWith("Auto-approved by Autopilot") ? "Autopilot approved" : "Approved"} small />;
  return <StatusChip status="draft" label={item.status.replaceAll("_", " ")} small />;
}

type Decision = (id: string, decision: "confirm" | "cancel" | "edit" | "production", changes?: Record<string, unknown>) => Promise<boolean>;

function ReelProductionCard({ item, busy, onDecision, onProduce, onProduceVideo, onRefresh }: { item: ApprovalItem; busy: boolean; onDecision: Decision; onProduce: (id: string) => Promise<void>; onProduceVideo: (id: string) => Promise<void>; onRefresh: (id: string, action: ApprovalItem) => void }) {
  const value = item.new_value ?? {}; const methods = Array.isArray(value.availableMethods) ? value.availableMethods.filter((method): method is string => typeof method === "string") : [];
  const selected = typeof value.selectedProductionMethod === "string" ? value.selectedProductionMethod : null;
  const shots = Array.isArray(value.shotInstructions) ? value.shotInstructions.filter((shot): shot is string => typeof shot === "string") : [];
  const [assetReady, setAssetReady] = useState(value.assetReceived === true); const produced = value.productionStatus === "produced";
  const productionStatus = String(value.productionStatus ?? "");
  const videoActive = productionStatus === "video_preparing" || productionStatus === "video_generating" || productionStatus === "video_processing";
  const videoProduced = produced && typeof value.generationId === "string";
  const videoFailed = productionStatus === "video_failed";
  const [video, setVideo] = useState<{ id: string; status: string; durationSeconds: number | null; previewUrl: string | null } | null>(null);
  const shownMethods = assetReady && !methods.includes("create_with_mara") ? [...methods, "create_with_mara"] : methods;

  // Real job polling: each GET lazily advances the server-side video job and
  // returns a fresh signed preview URL when the video is validated and stored.
  useEffect(() => {
    if (!videoActive && !videoProduced) return;
    let cancelled = false;
    async function tick() {
      try {
        const response = await fetch(`/api/reels/produce/${item.id}`, { cache: "no-store" });
        const body = await response.json() as { action?: ApprovalItem; generation?: { id: string; status: string; durationSeconds: number | null; previewUrl: string | null } | null };
        if (cancelled) return;
        if (response.ok && body.action) onRefresh(item.id, body.action);
        if (body.generation) setVideo(body.generation);
      } catch { /* transient — keep polling */ }
    }
    void tick();
    if (!videoActive) return () => { cancelled = true; };
    const timer = window.setInterval(() => void tick(), 8000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [videoActive, videoProduced, item.id, onRefresh]);
  return <div className="overflow-hidden rounded-[18px] border border-line bg-surface"><div className="border-l-[3px] border-[var(--brand)] p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><span className="text-[10px] font-bold uppercase tracking-[.09em] text-brand">Reel production choice</span><h2 className="mt-1 font-display text-lg font-semibold">{String(value.concept ?? "Reel concept")}</h2></div><Tag tone={produced ? "t-green" : videoFailed ? "t-red" : videoActive ? "t-blue" : selected ? "t-blue" : "t-amber"}>{busy ? "Producing…" : selected ? statusLabel(String(value.productionStatus ?? "")) : "Voom needs your choice"}</Tag></div>
    <div className="mt-4 grid gap-4 sm:grid-cols-2"><section><h3 className="text-xs font-semibold uppercase tracking-wide text-text-3">Short script</h3><p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-text-2">{String(value.script ?? "")}</p></section><section><h3 className="text-xs font-semibold uppercase tracking-wide text-text-3">What Voom needs</h3><p className="mt-1.5 text-sm leading-relaxed text-text-2">{typeof value.missingAssetRequest === "string" ? value.missingAssetRequest : "No authentic real-world footage is required for this concept."}</p></section></div>
    {shots.length > 0 && <section className="mt-4 rounded-xl border border-line bg-surface-2 p-3.5"><h3 className="text-xs font-semibold uppercase tracking-wide text-text-3">Simple shot instructions</h3><ul className="mt-2 space-y-1 text-sm text-text-2">{shots.map((shot) => <li key={shot}>• {shot}</li>)}</ul></section>}
    <div className="mt-4 flex flex-wrap gap-2">{shownMethods.map((method) => <Btn key={method} size="sm" variant={method === "create_with_mara" || selected === method || (!selected && value.recommendedMethod === method) ? "primary" : "outline"} disabled={busy || videoActive || (produced && method === "create_with_mara")} onClick={() => method === "create_with_mara" ? (videoProduced || videoFailed ? void onProduceVideo(item.id) : void onProduce(item.id)) : void onDecision(item.id, "production", { method })}>{method === "create_with_mara" && produced ? "Produced" : videoFailed && method === "create_with_mara" ? "Try again" : methodLabel(method)}{!selected && value.recommendedMethod === method ? " · Recommended" : ""}</Btn>)}</div>
    {selected && <p className="mt-3 text-sm font-medium text-text-2">{item.result_summary}</p>}
    {videoActive && <div className="mt-3 rounded-xl border border-brand/35 bg-[var(--brand-soft)] p-3.5"><p className="text-sm font-medium text-brand">{productionStatus === "video_processing" ? "MARA is processing the generated video." : "MARA is generating this Reel video."}</p><p className="mt-1 text-[12.5px] leading-relaxed text-text-2">This can take a few minutes. The card updates on its own — your previous asset is unchanged until the new video is validated and stored.</p></div>}
    {videoFailed && <div role="alert" className="mt-3 rounded-xl border border-red/35 bg-red/10 p-3.5"><p className="text-sm font-medium text-red">Reel video production stopped safely.</p><p className="mt-1 text-[12.5px] leading-relaxed text-text-2">{item.error_summary ?? "Generation couldn't finish. Your previous asset is unchanged — try again when you're ready."}</p></div>}
    {videoProduced && (
      <div className="mt-3 rounded-xl border border-line bg-surface-2 p-3.5">
        <div className="mx-auto w-full max-w-[210px] overflow-hidden rounded-[18px] border border-line bg-black">
          {video?.previewUrl ? <video src={video.previewUrl} controls playsInline preload="metadata" className="aspect-[9/16] h-auto w-full object-cover" /> : <div className="grid aspect-[9/16] place-items-center text-xs text-text-3">Loading preview…</div>}
        </div>
        <p className="mt-2 text-center text-[11px] text-text-3">{video?.durationSeconds ? `${video.durationSeconds}s · ` : ""}MARA-generated video · stored privately in Voom · nothing published</p>
        <div className="mt-2.5 flex flex-wrap justify-center gap-2">
          <Link href="/app/studio" className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-text-2 hover:bg-surface-2"><Icon name="plus" size={13} /> Open in Studio</Link>
          <Btn size="sm" variant="outline" disabled={busy} onClick={() => void onProduceVideo(item.id)}><Icon name="spark" size={13} /> Regenerate video</Btn>
        </div>
      </div>
    )}
    {(selected === "upload_asset" || selected === "film_yourself") && <ReelAssetUpload actionId={item.id} received={assetReady} onReceived={() => setAssetReady(true)} allowedKinds={Array.isArray(value.allowedAssetKinds) ? value.allowedAssetKinds.filter((kind): kind is string => typeof kind === "string") : ["image", "video"]} />}
    {produced && !videoProduced && <ReelCompositionPlayer actionId={item.id} value={value} />}
    <p className="mt-2 text-[11px] text-text-3">Nothing has been published externally.</p>
  </div></div>;
}

interface ReelAssetView { id: string; name: string; mimeType: string; byteSize: number; status: string; updatedAt: string; previewUrl: string | null; }
function ReelAssetUpload({ actionId, received, allowedKinds, onReceived }: { actionId: string; received: boolean; allowedKinds: string[]; onReceived: () => void }) {
  const [assets, setAssets] = useState<ReelAssetView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState(""); const [messageError, setMessageError] = useState(false);
  const uploadSeq = useRef(0);
  useEffect(() => {
    if (!received) return;
    let active = true;
    void fetch(`/api/reels/assets/${actionId}`, { cache: "no-store" }).then((response) => response.json()).then((body: { assets?: ReelAssetView[] }) => { if (active) setAssets(Array.isArray(body.assets) ? body.assets : []); }).catch(() => undefined);
    return () => { active = false; };
  }, [actionId, received]);
  async function upload(file: File | undefined, replaceId?: string) {
    if (!file) return; uploadSeq.current += 1; const tempId = `upload-${uploadSeq.current}`;
    setBusyId(tempId); setProgress(0); setMessage(""); setMessageError(false);
    if (file.size > REEL_ASSET_MAX_BYTES) { setMessage("That file is too large. Choose one file up to 4 MB."); setMessageError(true); setBusyId(null); return; }
    if (!replaceId && assets.length >= REEL_ASSET_PACK_LIMIT) { setMessage(`This Reel already has ${REEL_ASSET_PACK_LIMIT} assets. Remove one before adding another.`); setMessageError(true); setBusyId(null); return; }
    const form = new FormData(); form.set("file", file);
    try {
      const response = await uploadFormData(`/api/reels/assets/${actionId}`, form, (percent) => setProgress(percent));
      const body = await response.json() as { assets?: ReelAssetView[]; error?: string; code?: string; requestId?: string; message?: string };
      if (!response.ok || !body.assets) { setMessage(formatIngestionClientError(body, "Voom couldn't upload that asset safely.")); setMessageError(true); }
      else {
        let next = body.assets;
        if (replaceId) {
          const removal = await fetch(`/api/reels/assets/${actionId}/${replaceId}`, { method: "DELETE" });
          const removed = await removal.json() as { assets?: ReelAssetView[]; error?: string; code?: string; requestId?: string };
          if (removal.ok && removed.assets) next = removed.assets;
        }
        setAssets(next); setMessage(body.message ?? "Asset received."); onReceived(); window.dispatchEvent(new Event("voom:data-changed"));
      }
    } catch { setMessage("Voom couldn't upload that asset safely."); setMessageError(true); }
    setBusyId(null);
  }
  async function remove(id: string) {
    setBusyId(id); setMessage(""); setMessageError(false);
    try {
      const response = await fetch(`/api/reels/assets/${actionId}/${id}`, { method: "DELETE" });
      const body = await response.json() as { assets?: ReelAssetView[]; error?: string; code?: string; requestId?: string; message?: string };
      if (!response.ok || !body.assets) { setMessage(formatIngestionClientError(body, "Voom couldn't remove that asset safely.")); setMessageError(true); }
      else { setAssets(body.assets); setMessage(body.message ?? "Asset removed."); window.dispatchEvent(new Event("voom:data-changed")); }
    } catch { setMessage("Voom couldn't remove that asset safely."); setMessageError(true); }
    setBusyId(null);
  }
  const accept = allowedKinds.length === 1 && allowedKinds[0] === "video" ? ".mp4,.mov" : REEL_ASSET_ACCEPT;
  const uploading = busyId !== null;
  return <section className="mt-4 rounded-xl border border-line bg-surface-2 p-3.5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-xs font-semibold uppercase tracking-wide text-text-3">Reel asset pack</h3><p className="mt-1 text-sm text-text-2">Up to 6 private photos or videos. One is enough — more give MARA more visual material.</p></div>
      <Tag tone={assets.length ? "t-green" : "t-amber"}>{assets.length} of {REEL_ASSET_PACK_LIMIT} assets added</Tag>
    </div>
    {assets.length > 0 && <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {assets.map((assetItem, index) => <div key={assetItem.id} className="rounded-lg border border-line bg-surface p-2.5">
        <div className="relative aspect-video overflow-hidden rounded-md bg-black/40">
          {assetItem.previewUrl ? (assetItem.mimeType.startsWith("video/") ? <video className="h-full w-full object-cover" src={assetItem.previewUrl} muted playsInline preload="metadata" /> : <img className="h-full w-full object-cover" src={assetItem.previewUrl} alt={`Private Reel asset ${index + 1}`} />) : <div className="grid h-full place-items-center text-[11px] text-text-3">Preview unavailable</div>}
          {busyId === assetItem.id && <div className="absolute inset-0 grid place-items-center bg-black/60 text-[11px] font-semibold text-white">Removing…</div>}
        </div>
        <p className="mt-2 truncate text-xs font-medium text-text-2" title={assetItem.name}>{index + 1}. {assetItem.name}</p>
        <p className="text-[10.5px] text-text-3">{assetItem.mimeType.startsWith("video/") ? "Video" : "Photo"} · {formatBytes(assetItem.byteSize)}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center rounded-[8px] border border-line bg-surface px-2.5 py-1.5 text-[11.5px] font-semibold hover:border-brand"><input className="sr-only" type="file" accept={accept} disabled={uploading} onChange={(event) => void upload(event.currentTarget.files?.[0], assetItem.id)} />Replace asset</label>
          <button type="button" className="inline-flex items-center rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-red hover:border-red/40" disabled={uploading} onClick={() => void remove(assetItem.id)}>Remove</button>
        </div>
      </div>)}
      {busyId && busyId.startsWith("upload-") && <div className="rounded-lg border border-line bg-surface p-3"><div className="flex items-center justify-between text-xs text-text-2"><span>Uploading…</span><span>{progress}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} /></div></div>}
    </div>}
    {assets.length < REEL_ASSET_PACK_LIMIT && <label className="mt-3 inline-flex cursor-pointer items-center rounded-[9px] border border-line bg-surface px-3.5 py-2 text-[13px] font-semibold hover:border-brand"><input className="sr-only" type="file" accept={accept} disabled={uploading} onChange={(event) => void upload(event.currentTarget.files?.[0])} />{uploading ? "Uploading…" : assets.length ? "Add another asset" : "Choose asset"}</label>}
    <p className="mt-2 text-[11px] text-text-3">{allowedKinds.length === 1 ? "MP4 or MOV" : "JPEG, PNG, WebP, MP4, or MOV"} · max 4 MB each · private access · {assets.length < REEL_ASSET_PACK_LIMIT ? `${REEL_ASSET_PACK_LIMIT - assets.length} more allowed` : "pack limit reached"}</p>
    {message && <p role="status" className={`mt-2 text-sm ${messageError ? "text-red" : "text-green"}`}>{message}</p>}
  </section>;
}
function uploadFormData(url: string, form: FormData, onProgress: (percent: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100))); };
    request.onload = () => resolve(new Response(request.responseText, { status: request.status, headers: { "Content-Type": request.getResponseHeader("Content-Type") ?? "application/json" } }));
    request.onerror = () => reject(new Error("upload_failed"));
    request.send(form);
  });
}
function formatBytes(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }

function ApprovalCard({ item, busy, onDecision, confirmBlockedReason }: { item: ApprovalItem; busy: boolean; onDecision: Decision; confirmBlockedReason?: string }) {
  const [editing, setEditing] = useState(false); const [text, setText] = useState(() => editableText(item.new_value));
  const [publishAt, setPublishAt] = useState(() => toDubaiLocal(item.new_value?.publishAt)); const [validation, setValidation] = useState("");
  const failed = item.status === "failed"; const detail = details(item); const contentApproval = isEditableCalendarContent(item);
  async function save() {
    setValidation("");
    if (contentApproval) {
      const content = text.trim(); const scheduled = fromDubaiLocal(publishAt);
      if (!content) return setValidation("Caption cannot be empty.");
      if (!scheduled) return setValidation("Choose a valid publishing date and time.");
      if (new Date(scheduled).getTime() < Date.now() - 300000) return setValidation("Choose a time that has not already passed.");
      if (await onDecision(item.id, "edit", { content, publishAt: scheduled })) setEditing(false);
      return;
    }
    const key = editableKey(item.new_value); if (!key || !text.trim()) return;
    if (await onDecision(item.id, "edit", { [key]: text.trim() })) setEditing(false);
  }
  return <div className="overflow-hidden rounded-[18px] border border-line bg-surface"><div className="border-l-[3px] border-[var(--brand)] p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><span className="text-[10px] font-bold uppercase tracking-[.09em] text-brand">Approval required</span><h2 className="mt-1 font-display text-lg font-semibold">{item.summary}</h2></div><Tag tone={failed ? "t-red" : "t-amber"}>{failed ? "Retry needed" : "Waiting for you"}</Tag></div>
    <dl className="mt-4 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
      <Info label="Why Voom recommends it" value={detail.why} />
      <Info label="Channel" value={detail.channel} />
      <Info label="Scheduled for" value={scheduledFact(item)} />
    </dl>
    {contentApproval && !editing && <div className="mt-4 min-w-0 rounded-2xl border border-line bg-[var(--surface)]/70 p-3.5">
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Content preview</span>
      <p className="mt-1.5 max-h-[220px] overflow-hidden whitespace-pre-wrap text-[13px] leading-relaxed text-text-2">{String(item.new_value?.content ?? "").slice(0, 1500)}</p>
      {typeof item.new_value?.topic === "string" && item.new_value.topic ? <p className="mt-2 text-[11.5px] text-text-3">Topic: {String(item.new_value.topic)}</p> : null}
    </div>}
    {item.old_value && <Values title="Current" value={item.old_value} />}
    {editing ? <div className="mt-4 space-y-3"><label className="block"><span className="mb-1.5 block text-xs font-semibold text-text-2">{contentApproval ? "Instagram caption" : `Edit proposed ${editableKey(item.new_value)?.replaceAll("_", " ") ?? "content"}`}</span><Textarea rows={7} value={text} maxLength={12000} onChange={(event) => setText(event.target.value)} /></label>{contentApproval && <label className="block"><span className="mb-1.5 block text-xs font-semibold text-text-2">Scheduled date and time</span><Input type="datetime-local" value={publishAt} onInput={(event) => setPublishAt(event.currentTarget.value)} /></label>}{validation && <p role="alert" className="text-sm text-red">{validation}</p>}</div> : item.new_value && <Values title="Exact proposed change" value={item.new_value} />}
    {failed && <p className="mt-3 text-sm text-red">{item.error_summary ?? "The previous attempt failed safely. Nothing was changed."}</p>}
    <div className="mt-4 flex flex-wrap gap-2">{editing ? <><Btn size="sm" variant="primary" disabled={busy || !text.trim() || (contentApproval && !publishAt)} onClick={() => void save()}>Save edit</Btn><Btn size="sm" variant="ghost" onClick={() => { setEditing(false); setValidation(""); setText(editableText(item.new_value)); setPublishAt(toDubaiLocal(item.new_value?.publishAt)); }}>Cancel edit</Btn></> : <><Btn size="sm" variant="primary" disabled={busy || Boolean(confirmBlockedReason)} title={confirmBlockedReason} onClick={() => void onDecision(item.id, "confirm")}>{failed ? "Retry" : "Confirm"}</Btn><Btn size="sm" variant="outline" disabled={busy || !editableKey(item.new_value)} onClick={() => setEditing(true)}>Edit</Btn>{!failed && <Btn size="sm" variant="danger" disabled={busy} onClick={() => void onDecision(item.id, "cancel")}>Cancel</Btn>}<Link href={detail.href} className="inline-flex h-[34px] items-center rounded-[9px] border border-line px-3.5 text-[13px] font-semibold hover:border-brand">{detail.link} →</Link></> }</div>
    <p className="mt-3 text-[11px] leading-relaxed text-text-3">Confirm changes Voom data only. It never publishes, sends, deletes externally, or spends money without separate permission.</p>
  </div></div>;
}
const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The action's own proposed publish instant, in the business timezone. */
function scheduledFact(item: ApprovalItem) {
  const local = toDubaiLocal(item.new_value?.publishAt);
  if (!local) return "Not scheduled yet";
  const [date, time] = local.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${MONTH_ABBREVIATIONS[month - 1] ?? ""} ${day}, ${year} · ${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}
function Info({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs font-semibold text-text-3">{label}</dt><dd className="mt-1 leading-relaxed text-text-2">{value}</dd></div>; }
function Values({ title, value }: { title: string; value: Record<string, unknown> }) { const rows = Object.entries(value).filter(([key, entry]) => !key.toLowerCase().includes("id") && (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")).slice(0, 12); if (!rows.length) return null; return <div className="mt-4 rounded-xl border border-line bg-surface-2 p-3.5"><b className="text-xs uppercase tracking-wide text-text-3">{title}</b><dl className="mt-2 grid gap-2">{rows.map(([key, entry]) => <div key={key} className="grid gap-1 text-sm sm:grid-cols-[150px_1fr]"><dt className="capitalize text-text-3">{key.replaceAll("_", " ").replaceAll(/([A-Z])/g, " $1")}</dt><dd className="whitespace-pre-wrap break-words">{formatValue(key, entry)}</dd></div>)}</dl></div>; }
function details(item: ApprovalItem) { const calendar = item.tool_name.includes("calendar"); const campaign = item.tool_name.includes("campaign"); const approval = item.tool_name.includes("approve"); return { why: typeof item.new_value?.reason === "string" ? item.new_value.reason : calendar ? "This keeps the proposed content timing aligned with your current plan." : campaign ? "This prepares campaign work for review without sending it." : approval ? "This records your decision before any later execution step." : "This protected change needs your review before Voom applies it.", channel: String(item.new_value?.channel ?? (campaign ? "Campaign" : approval ? "Content" : "Voom")), href: calendar ? "/app/calendar" : campaign ? "/app/campaigns" : "/app/plan", link: calendar ? "View calendar" : campaign ? "View campaign" : "View plan" }; }
function editableKey(value: Record<string, unknown> | null) { if (!value) return null; return ["content", "caption", "title", "topic", "objective", "publishAt", "proposedSendAt", "budget"].find((key) => typeof value[key] === "string") ?? null; }
function editableText(value: Record<string, unknown> | null) { const key = editableKey(value); return key ? String(value?.[key] ?? "") : ""; }
function formatValue(key: string, value: unknown) { if (typeof value === "string" && /(at|time|date)$/i.test(key) && !Number.isNaN(Date.parse(value))) return new Date(value).toLocaleString("en-AE", { timeZone: "Asia/Dubai" }); return String(value); }
function isEditableCalendarContent(item: ApprovalItem) { return item.tool_name === "propose_calendar_item" && typeof item.new_value?.content === "string" && typeof item.new_value?.publishAt === "string" && typeof item.new_value?.sourceDraftId === "string"; }
function toDubaiLocal(value: unknown) { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return ""; const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)); const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ""; return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`; }
function fromDubaiLocal(value: string) { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}:00+04:00`)) ? `${value}:00+04:00` : null; }
function methodLabel(method: string) { return method === "create_with_mara" ? "Create with MARA" : method === "film_yourself" ? "Film it myself" : "Use existing asset"; }
function statusLabel(status: string) { return status === "produced" ? "Ready for review" : status === "video_generating" ? "Generating video" : status === "video_processing" ? "Processing video" : status === "video_preparing" ? "Preparing video" : status === "video_failed" ? "Video needs retry" : status === "producing" ? "Producing" : status === "preparing" ? "Preparing" : status === "production_failed" ? "Production needs retry" : status === "ready_for_mara_production" ? "Ready for MARA" : status === "waiting_for_filming" ? "Waiting for filming" : status === "waiting_for_asset_upload" ? "Waiting for upload" : "Choice saved"; }
