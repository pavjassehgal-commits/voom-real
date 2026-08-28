"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/voom/icons";
import { Btn, Card, Tag, Textarea } from "@/components/voom/ui/primitives";

export interface ApprovalItem { id: string; tool_name: string; summary: string; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null; status: string; result_summary: string | null; error_summary: string | null; created_at: string; }

export function ApprovalsBoard({ initial }: { initial: ApprovalItem[] }) {
  const [items, setItems] = useState(initial); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState("");
  async function decide(id: string, decision: "confirm" | "cancel" | "edit", changes?: Record<string, unknown>) {
    setBusy(id); setError("");
    const response = await fetch(`/api/mara/actions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, changes }) });
    const body = await response.json() as { action?: ApprovalItem; error?: string };
    if (response.ok && body.action) { setItems((current) => current.map((item) => item.id === id ? body.action! : item)); window.dispatchEvent(new Event("voom:data-changed")); }
    else setError(body.error ?? "Voom couldn't safely update that action.");
    setBusy(null);
  }
  const open = items.filter((item) => item.status === "pending" || item.status === "failed");
  const completed = items.filter((item) => item.status !== "pending" && item.status !== "failed");
  return <div>
    {error && <div role="alert" className="mb-4 rounded-xl border border-red/35 bg-red/10 px-4 py-3 text-sm text-red">{error}</div>}
    {open.length ? <div className="space-y-4">{open.map((item) => <ApprovalCard key={item.id} item={item} busy={busy === item.id} onDecision={decide} />)}</div> : <Card className="p-8 text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-line text-green"><Icon name="check" size={22} /></span><h2 className="mt-3 font-display text-lg font-semibold">Nothing needs your approval</h2><p className="mx-auto mt-1 max-w-md text-sm text-text-3">When Voom recommends a calendar change, approval, deletion, or another protected action, it will appear here first.</p></Card>}
    {completed.length > 0 && <section className="mt-7"><h2 className="mb-3 font-display text-base font-semibold">Recent decisions</h2><Card className="overflow-hidden">{completed.slice(0, 12).map((item) => <div key={item.id} className="flex items-start justify-between gap-4 border-t border-line px-4 py-3 first:border-0"><div><b className="text-sm">{item.summary}</b><p className="mt-1 text-xs text-text-3">{item.result_summary ?? item.error_summary ?? "No database change was made."}</p></div><Tag tone={item.status === "confirmed" ? "t-green" : "t-grey"}>{item.status}</Tag></div>)}</Card></section>}
  </div>;
}

function ApprovalCard({ item, busy, onDecision }: { item: ApprovalItem; busy: boolean; onDecision: (id: string, decision: "confirm" | "cancel" | "edit", changes?: Record<string, unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState(false); const [text, setText] = useState(() => editableText(item.new_value));
  const failed = item.status === "failed"; const detail = details(item);
  async function save() { const key = editableKey(item.new_value); if (!key || !text.trim()) return; await onDecision(item.id, "edit", { [key]: text.trim() }); setEditing(false); }
  return <Card className="overflow-hidden border-brand/30"><div className="border-l-[3px] border-brand p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><span className="text-[10px] font-bold uppercase tracking-[.09em] text-brand">Approval required</span><h2 className="mt-1 font-display text-lg font-semibold">{item.summary}</h2></div><Tag tone={failed ? "t-red" : "t-amber"}>{failed ? "Retry needed" : "Waiting for you"}</Tag></div>
    <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><Info label="Why Voom recommends it" value={detail.why} /><Info label="Channel" value={detail.channel} /></dl>
    {item.old_value && <Values title="Current" value={item.old_value} />}
    {editing ? <div className="mt-4"><label className="mb-1.5 block text-xs font-semibold text-text-2">Edit proposed {editableKey(item.new_value)?.replaceAll("_", " ") ?? "content"}</label><Textarea rows={7} value={text} maxLength={12000} onChange={(event) => setText(event.target.value)} /></div> : item.new_value && <Values title="Exact proposed change" value={item.new_value} />}
    {failed && <p className="mt-3 text-sm text-red">{item.error_summary ?? "The previous attempt failed safely. Nothing was changed."}</p>}
    <div className="mt-4 flex flex-wrap gap-2">{editing ? <><Btn size="sm" variant="primary" disabled={busy || !text.trim()} onClick={() => void save()}>Save edit</Btn><Btn size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel edit</Btn></> : <><Btn size="sm" variant="primary" disabled={busy} onClick={() => void onDecision(item.id, "confirm")}>{failed ? "Retry" : "Confirm"}</Btn><Btn size="sm" variant="outline" disabled={busy || !editableKey(item.new_value)} onClick={() => setEditing(true)}>Edit</Btn>{!failed && <Btn size="sm" variant="danger" disabled={busy} onClick={() => void onDecision(item.id, "cancel")}>Cancel</Btn>}<Link href={detail.href} className="inline-flex h-[34px] items-center rounded-[9px] border border-line px-3.5 text-[13px] font-semibold hover:border-brand">{detail.link} →</Link></> }</div>
    <p className="mt-3 text-[11px] text-text-3">Confirm changes Voom data only. It never publishes, sends, deletes externally, or spends money without separate permission.</p>
  </div></Card>;
}
function Info({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs font-semibold text-text-3">{label}</dt><dd className="mt-1 leading-relaxed text-text-2">{value}</dd></div>; }
function Values({ title, value }: { title: string; value: Record<string, unknown> }) { const rows = Object.entries(value).filter(([key, entry]) => !key.toLowerCase().includes("id") && (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")).slice(0, 12); if (!rows.length) return null; return <div className="mt-4 rounded-xl border border-line bg-surface-2 p-3.5"><b className="text-xs uppercase tracking-wide text-text-3">{title}</b><dl className="mt-2 grid gap-2">{rows.map(([key, entry]) => <div key={key} className="grid gap-1 text-sm sm:grid-cols-[150px_1fr]"><dt className="capitalize text-text-3">{key.replaceAll("_", " ").replaceAll(/([A-Z])/g, " $1")}</dt><dd className="whitespace-pre-wrap break-words">{formatValue(key, entry)}</dd></div>)}</dl></div>; }
function details(item: ApprovalItem) { const calendar = item.tool_name.includes("calendar"); const campaign = item.tool_name.includes("campaign"); const approval = item.tool_name.includes("approve"); return { why: typeof item.new_value?.reason === "string" ? item.new_value.reason : calendar ? "This keeps the proposed content timing aligned with your current plan." : campaign ? "This prepares campaign work for review without sending it." : approval ? "This records your decision before any later execution step." : "This protected change needs your review before Voom applies it.", channel: String(item.new_value?.channel ?? (campaign ? "Campaign" : approval ? "Content" : "Voom")), href: calendar ? "/app/calendar" : campaign ? "/app/campaigns" : "/app/plan", link: calendar ? "View calendar" : campaign ? "View campaign" : "View plan" }; }
function editableKey(value: Record<string, unknown> | null) { if (!value) return null; return ["content", "caption", "title", "topic", "objective", "publishAt", "proposedSendAt", "budget"].find((key) => typeof value[key] === "string") ?? null; }
function editableText(value: Record<string, unknown> | null) { const key = editableKey(value); return key ? String(value?.[key] ?? "") : ""; }
function formatValue(key: string, value: unknown) { if (typeof value === "string" && /(at|time|date)$/i.test(key) && !Number.isNaN(Date.parse(value))) return new Date(value).toLocaleString("en-AE", { timeZone: "Asia/Dubai" }); return String(value); }
