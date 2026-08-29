"use client";
/* eslint-disable @next/next/no-img-element -- private signed URLs expire and must bypass the public image optimizer */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/voom/icons";
import { Btn, Card, Input, Tag, Textarea } from "@/components/voom/ui/primitives";
import { REEL_ASSET_ACCEPT, REEL_ASSET_MAX_BYTES } from "@/lib/media/reel-asset";
import { ReelCompositionPlayer } from "@/components/voom/operating/ReelCompositionPlayer";

export interface ApprovalItem { id: string; tool_name: string; summary: string; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null; status: string; result_summary: string | null; error_summary: string | null; created_at: string; }

export function ApprovalsBoard({ initial }: { initial: ApprovalItem[] }) {
  const [items, setItems] = useState(initial); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState("");
  async function decide(id: string, decision: "confirm" | "cancel" | "edit" | "production", changes?: Record<string, unknown>) {
    setBusy(id); setError("");
    const payload = decision === "production" ? { decision, method: changes?.method } : { decision, changes };
    const response = await fetch(`/api/mara/actions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json() as { action?: ApprovalItem; error?: string };
    if (response.ok && body.action) { setItems((current) => current.map((item) => item.id === id ? body.action! : item)); window.dispatchEvent(new Event("voom:data-changed")); }
    else setError(body.error ?? "Voom couldn't safely update that action.");
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
  const open = items.filter((item) => item.status === "pending" || item.status === "failed");
  const completed = items.filter((item) => item.status !== "pending" && item.status !== "failed");
  return <div>
    {error && <div role="alert" className="mb-4 rounded-xl border border-red/35 bg-red/10 px-4 py-3 text-sm text-red">{error}</div>}
    {open.length ? <div className="space-y-4">{open.map((item) => item.tool_name === "choose_reel_production" ? <ReelProductionCard key={item.id} item={item} busy={busy === item.id} onDecision={decide} onProduce={produce} /> : <ApprovalCard key={item.id} item={item} busy={busy === item.id} onDecision={decide} />)}</div> : <Card className="p-8 text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-line text-green"><Icon name="check" size={22} /></span><h2 className="mt-3 font-display text-lg font-semibold">Nothing needs your approval</h2><p className="mx-auto mt-1 max-w-md text-sm text-text-3">When Voom recommends a calendar change, approval, deletion, or another protected action, it will appear here first.</p></Card>}
    {completed.length > 0 && <section className="mt-7"><h2 className="mb-3 font-display text-base font-semibold">Recent decisions</h2><Card className="overflow-hidden">{completed.slice(0, 12).map((item) => <div key={item.id} className="flex items-start justify-between gap-4 border-t border-line px-4 py-3 first:border-0"><div><b className="text-sm">{item.summary}</b><p className="mt-1 text-xs text-text-3">{item.result_summary ?? item.error_summary ?? "No database change was made."}</p></div><Tag tone={item.status === "confirmed" ? "t-green" : "t-grey"}>{item.status === "confirmed" && item.result_summary?.startsWith("Auto-approved by Autopilot") ? "Autopilot approved" : item.status}</Tag></div>)}</Card></section>}
  </div>;
}

type Decision = (id: string, decision: "confirm" | "cancel" | "edit" | "production", changes?: Record<string, unknown>) => Promise<boolean>;

function ReelProductionCard({ item, busy, onDecision, onProduce }: { item: ApprovalItem; busy: boolean; onDecision: Decision; onProduce: (id: string) => Promise<void> }) {
  const value = item.new_value ?? {}; const methods = Array.isArray(value.availableMethods) ? value.availableMethods.filter((method): method is string => typeof method === "string") : [];
  const selected = typeof value.selectedProductionMethod === "string" ? value.selectedProductionMethod : null;
  const shots = Array.isArray(value.shotInstructions) ? value.shotInstructions.filter((shot): shot is string => typeof shot === "string") : [];
  const [assetReady, setAssetReady] = useState(value.assetReceived === true); const produced = value.productionStatus === "produced";
  const shownMethods = assetReady && !methods.includes("create_with_mara") ? [...methods, "create_with_mara"] : methods;
  return <Card className="overflow-hidden border-brand/30"><div className="border-l-[3px] border-brand p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><span className="text-[10px] font-bold uppercase tracking-[.09em] text-brand">Reel production choice</span><h2 className="mt-1 font-display text-lg font-semibold">{String(value.concept ?? "Reel concept")}</h2></div><Tag tone={produced ? "t-green" : selected ? "t-blue" : "t-amber"}>{busy ? "Producing…" : selected ? statusLabel(String(value.productionStatus ?? "")) : "Voom needs your choice"}</Tag></div>
    <div className="mt-4 grid gap-4 sm:grid-cols-2"><section><h3 className="text-xs font-semibold uppercase tracking-wide text-text-3">Short script</h3><p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-text-2">{String(value.script ?? "")}</p></section><section><h3 className="text-xs font-semibold uppercase tracking-wide text-text-3">What Voom needs</h3><p className="mt-1.5 text-sm leading-relaxed text-text-2">{typeof value.missingAssetRequest === "string" ? value.missingAssetRequest : "No authentic real-world footage is required for this concept."}</p></section></div>
    {shots.length > 0 && <section className="mt-4 rounded-xl border border-line bg-surface-2 p-3.5"><h3 className="text-xs font-semibold uppercase tracking-wide text-text-3">Simple shot instructions</h3><ul className="mt-2 space-y-1 text-sm text-text-2">{shots.map((shot) => <li key={shot}>• {shot}</li>)}</ul></section>}
    <div className="mt-4 flex flex-wrap gap-2">{shownMethods.map((method) => <Btn key={method} size="sm" variant={method === "create_with_mara" || selected === method || (!selected && value.recommendedMethod === method) ? "primary" : "outline"} disabled={busy || (produced && method === "create_with_mara")} onClick={() => method === "create_with_mara" ? void onProduce(item.id) : void onDecision(item.id, "production", { method })}>{method === "create_with_mara" && produced ? "Produced" : methodLabel(method)}{!selected && value.recommendedMethod === method ? " · Recommended" : ""}</Btn>)}</div>
    {selected && <p className="mt-3 text-sm font-medium text-text-2">{item.result_summary}</p>}
    {(selected === "upload_asset" || selected === "film_yourself") && <ReelAssetUpload actionId={item.id} received={assetReady} onReceived={() => setAssetReady(true)} allowedKinds={Array.isArray(value.allowedAssetKinds) ? value.allowedAssetKinds.filter((kind): kind is string => typeof kind === "string") : ["image", "video"]} />}
    {produced && <ReelCompositionPlayer actionId={item.id} value={value} />}
    <p className="mt-2 text-[11px] text-text-3">Nothing has been published externally.</p>
  </div></Card>;
}

interface ReelAssetView { name: string; mimeType: string; byteSize: number; status: string; updatedAt: string; previewUrl: string | null; }
function ReelAssetUpload({ actionId, received, allowedKinds, onReceived }: { actionId: string; received: boolean; allowedKinds: string[]; onReceived: () => void }) {
  const [asset, setAsset] = useState<ReelAssetView | null>(null); const [uploading, setUploading] = useState(false); const [message, setMessage] = useState(""); const [messageError, setMessageError] = useState(false);
  useEffect(() => {
    if (!received) return;
    let active = true;
    void fetch(`/api/reels/assets/${actionId}`, { cache: "no-store" }).then((response) => response.json()).then((body: { asset?: ReelAssetView }) => { if (active && body.asset) setAsset(body.asset); }).catch(() => undefined);
    return () => { active = false; };
  }, [actionId, received]);
  async function upload(file: File | undefined) {
    if (!file) return; setUploading(true); setMessage(""); setMessageError(false);
    if (file.size > REEL_ASSET_MAX_BYTES) { setMessage("That file is too large. Choose one file up to 4 MB."); setMessageError(true); setUploading(false); return; }
    const form = new FormData(); form.set("file", file);
    try {
      const response = await fetch(`/api/reels/assets/${actionId}`, { method: "POST", body: form });
      const body = await response.json() as { asset?: ReelAssetView; error?: string; message?: string };
      if (!response.ok || !body.asset) { setMessage(body.error ?? "Voom couldn't upload that asset safely."); setMessageError(true); }
      else { setAsset(body.asset); setMessage(body.message ?? "Asset received."); onReceived(); window.dispatchEvent(new Event("voom:data-changed")); }
    } catch { setMessage("Voom couldn't upload that asset safely."); setMessageError(true); }
    setUploading(false);
  }
  const accept = allowedKinds.length === 1 && allowedKinds[0] === "video" ? ".mp4,.mov" : REEL_ASSET_ACCEPT;
  return <section className="mt-4 rounded-xl border border-line bg-surface-2 p-3.5">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-xs font-semibold uppercase tracking-wide text-text-3">One Reel asset</h3><p className="mt-1 text-sm text-text-2">{asset ? `${asset.name} · ${formatBytes(asset.byteSize)}` : "Upload the requested footage or an existing asset."}</p></div>{asset && <Tag tone="t-green">Asset received</Tag>}</div>
    {asset?.previewUrl && (asset.mimeType.startsWith("image/") ? <img className="mt-3 max-h-48 rounded-lg object-contain" src={asset.previewUrl} alt="Secure Reel asset preview" /> : <video className="mt-3 max-h-56 max-w-full rounded-lg" src={asset.previewUrl} controls preload="metadata" />)}
    <label className="mt-3 inline-flex cursor-pointer items-center rounded-[9px] border border-line bg-surface px-3.5 py-2 text-[13px] font-semibold hover:border-brand"><input className="sr-only" type="file" accept={accept} disabled={uploading} onChange={(event) => void upload(event.currentTarget.files?.[0])} />{uploading ? "Uploading…" : asset ? "Replace asset" : "Choose asset"}</label>
    <p className="mt-2 text-[11px] text-text-3">{allowedKinds.length === 1 ? "MP4 or MOV" : "JPEG, PNG, WebP, MP4, or MOV"} · maximum 4 MB · private access</p>
    {message && <p role="status" className={`mt-2 text-sm ${messageError ? "text-red" : "text-green"}`}>{message}</p>}
  </section>;
}
function formatBytes(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }

function ApprovalCard({ item, busy, onDecision }: { item: ApprovalItem; busy: boolean; onDecision: Decision }) {
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
  return <Card className="overflow-hidden border-brand/30"><div className="border-l-[3px] border-brand p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><span className="text-[10px] font-bold uppercase tracking-[.09em] text-brand">Approval required</span><h2 className="mt-1 font-display text-lg font-semibold">{item.summary}</h2></div><Tag tone={failed ? "t-red" : "t-amber"}>{failed ? "Retry needed" : "Waiting for you"}</Tag></div>
    <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><Info label="Why Voom recommends it" value={detail.why} /><Info label="Channel" value={detail.channel} /></dl>
    {item.old_value && <Values title="Current" value={item.old_value} />}
    {editing ? <div className="mt-4 space-y-3"><label className="block"><span className="mb-1.5 block text-xs font-semibold text-text-2">{contentApproval ? "Instagram caption" : `Edit proposed ${editableKey(item.new_value)?.replaceAll("_", " ") ?? "content"}`}</span><Textarea rows={7} value={text} maxLength={12000} onChange={(event) => setText(event.target.value)} /></label>{contentApproval && <label className="block"><span className="mb-1.5 block text-xs font-semibold text-text-2">Scheduled date and time</span><Input type="datetime-local" value={publishAt} onInput={(event) => setPublishAt(event.currentTarget.value)} /></label>}{validation && <p role="alert" className="text-sm text-red">{validation}</p>}</div> : item.new_value && <Values title="Exact proposed change" value={item.new_value} />}
    {failed && <p className="mt-3 text-sm text-red">{item.error_summary ?? "The previous attempt failed safely. Nothing was changed."}</p>}
    <div className="mt-4 flex flex-wrap gap-2">{editing ? <><Btn size="sm" variant="primary" disabled={busy || !text.trim() || (contentApproval && !publishAt)} onClick={() => void save()}>Save edit</Btn><Btn size="sm" variant="ghost" onClick={() => { setEditing(false); setValidation(""); setText(editableText(item.new_value)); setPublishAt(toDubaiLocal(item.new_value?.publishAt)); }}>Cancel edit</Btn></> : <><Btn size="sm" variant="primary" disabled={busy} onClick={() => void onDecision(item.id, "confirm")}>{failed ? "Retry" : "Confirm"}</Btn><Btn size="sm" variant="outline" disabled={busy || !editableKey(item.new_value)} onClick={() => setEditing(true)}>Edit</Btn>{!failed && <Btn size="sm" variant="danger" disabled={busy} onClick={() => void onDecision(item.id, "cancel")}>Cancel</Btn>}<Link href={detail.href} className="inline-flex h-[34px] items-center rounded-[9px] border border-line px-3.5 text-[13px] font-semibold hover:border-brand">{detail.link} →</Link></> }</div>
    <p className="mt-3 text-[11px] text-text-3">Confirm changes Voom data only. It never publishes, sends, deletes externally, or spends money without separate permission.</p>
  </div></Card>;
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
function statusLabel(status: string) { return status === "produced" ? "Ready for review" : status === "producing" ? "Producing" : status === "preparing" ? "Preparing" : status === "production_failed" ? "Production needs retry" : status === "ready_for_mara_production" ? "Ready for MARA" : status === "waiting_for_filming" ? "Waiting for filming" : status === "waiting_for_asset_upload" ? "Waiting for upload" : "Choice saved"; }
