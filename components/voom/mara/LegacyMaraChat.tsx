"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import type { MaraDraftRecord, MaraMessageRecord } from "@/lib/mara/types";
import type { MaraPendingActionRecord } from "@/lib/mara/tool-types";
import type { MediaGenerationRecord } from "@/lib/media/types";
import { Icon } from "@/components/voom/icons";
import { Orb } from "@/components/voom/ui/primitives";

const QUICKS = ["Create an Instagram image", "Generate a 9:16 Reel video", "Plan next week", "Write an Instagram caption", "Create a Reel script", "Draft a win-back email"];
type LoadPayload = { conversation: { id: string } | null; messages: MaraMessageRecord[]; drafts: MaraDraftRecord[]; pendingActions: MaraPendingActionRecord[]; media: MediaGenerationRecord[] };

export default function LegacyMaraChat() {
  const { brand, igConnected } = useVoomState();
  const { goTo, toast } = useVoomActions();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MaraMessageRecord[]>([]);
  const [drafts, setDrafts] = useState<MaraDraftRecord[]>([]);
  const [pendingActions, setPendingActions] = useState<MaraPendingActionRecord[]>([]);
  const [media, setMedia] = useState<MediaGenerationRecord[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const startedMediaRef = useRef(new Set<string>());

  const refreshMedia = useCallback(async (id: string) => {
    const response = await fetch(`/api/mara/media/${id}`, { cache: "no-store" });
    const data = await response.json() as { media?: MediaGenerationRecord; error?: string };
    if (response.ok && data.media) setMedia((current) => current.map((item) => item.id === id ? data.media! : item));
  }, []);

  const updateMedia = useCallback(async (id: string, action: "generate" | "confirm" | "cancel" | "regenerate" | "approve" | "reject" | "edit", prompt?: string) => {
    setError(null);
    const response = await fetch(`/api/mara/media/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, prompt }) });
    const data = await response.json() as { media?: MediaGenerationRecord; message?: string; error?: string };
    if (data.media) setMedia((current) => current.map((item) => item.id === id ? data.media! : item));
    if (!response.ok) { setError(data.error || "MARA couldn't generate that media just now."); return; }
    if (data.message) toast(data.message, action === "reject" || action === "cancel" ? "info" : "ok");
  }, [toast]);

  useEffect(() => {
    let active = true;
    fetch("/api/mara", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as LoadPayload & { error?: string };
        if (!response.ok) throw new Error(data.error || "MARA couldn't load your conversation.");
        if (!active) return;
        setConversationId(data.conversation?.id ?? null);
        setMessages(data.messages);
        setDrafts(data.drafts);
        setPendingActions(data.pendingActions ?? []);
        setMedia(data.media ?? []);
      })
      .catch((reason: Error) => active && setError(reason.message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [messages, streamingText, sending]);

  useEffect(() => {
    const queued = media.filter((item) => item.media_type === "image" && item.status === "queued" && !startedMediaRef.current.has(item.id));
    for (const item of queued) { startedMediaRef.current.add(item.id); void updateMedia(item.id, "generate"); }
  }, [media, updateMedia]);

  useEffect(() => {
    if (!media.some((item) => item.status === "processing")) return;
    const timer = window.setInterval(() => {
      for (const item of media) if (item.status === "processing") void refreshMedia(item.id);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [media, refreshMedia]);

  const send = useCallback(async (raw: string) => {
    const message = raw.trim();
    if (!message || sending) return;
    if (message.length > 4000) { setError("Keep messages under 4,000 characters."); return; }
    setDraft(""); setError(null); setSending(true); setStreamingText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const optimistic: MaraMessageRecord = { id: `pending-${Date.now()}`, conversation_id: conversationId ?? "pending", role: "user", content: message, created_at: new Date().toISOString() };
    const requestId = crypto.randomUUID();
    setMessages((current) => [...current, optimistic]);
    try {
      const response = await fetch("/api/mara", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, conversationId, requestId }) });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "MARA couldn't answer just now. Please retry.");
      }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as StreamEvent;
          if (event.type === "start") { setConversationId(event.conversationId); setMessages((current) => current.map((item) => item.id === optimistic.id ? event.userMessage : item)); }
          else if (event.type === "delta") setStreamingText((current) => current + event.content);
          else { setMessages((current) => [...current, event.assistantMessage]); if (event.draft) setDrafts((current) => [event.draft!, ...current]); if (event.pendingActions?.length) setPendingActions((current) => [...current, ...(event.pendingActions ?? [])]); if (event.media) setMedia((current) => [...current, event.media!]); setStreamingText(""); }
        }
        if (done) break;
      }
    } catch (reason) {
      setMessages((current) => current.filter((item) => item.id !== optimistic.id));
      setError(reason instanceof Error ? reason.message : "MARA couldn't answer just now. Please retry.");
    } finally { setSending(false); }
  }, [conversationId, sending]);

  async function updateDraft(id: string, action: "approve" | "reject" | "edit", content?: string, proposedPublishAt?: string | null) {
    const response = await fetch(`/api/mara/drafts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, content, proposedPublishAt }) });
    const data = await response.json() as { draft?: MaraDraftRecord; pendingAction?: MaraPendingActionRecord; message?: string; error?: string };
    if (!response.ok || (!data.draft && !data.pendingAction)) { setError(data.error || "We couldn't update that draft."); return; }
    if (data.pendingAction) {
      setPendingActions((current) => current.some((item) => item.id === data.pendingAction!.id) ? current : [...current, data.pendingAction!]);
      toast(data.message || "Confirm the approval below", "info"); return;
    }
    setDrafts((current) => current.map((item) => item.id === id ? data.draft! : item));
    toast(action === "approve" ? "Draft approved — nothing was published" : action === "reject" ? "Draft rejected" : "Draft saved", action === "reject" ? "info" : "ok");
  }

  async function copyDraft(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      toast("Draft copied", "ok");
    } catch {
      setError("We couldn't copy that draft. Select the text and copy it manually.");
    }
  }

  async function decideAction(id: string, decision: "confirm" | "cancel") {
    setError(null);
    setPendingActions((current) => current.map((item) => item.id === id ? { ...item, status: "executing" } : item));
    const response = await fetch(`/api/mara/actions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
    const data = await response.json() as { action?: MaraPendingActionRecord; message?: string; error?: string };
    if (!response.ok || !data.action) {
      setPendingActions((current) => current.map((item) => item.id === id ? { ...item, status: "failed", error_summary: data.error || "Voom couldn't apply that change safely." } : item));
      setError(data.error || "Voom couldn't apply that change safely."); return;
    }
    setPendingActions((current) => current.map((item) => item.id === id ? data.action! : item));
    if (data.action.status === "confirmed" && data.action.tool_name === "approve_draft") {
      const draftId = typeof data.action.new_value?.draftId === "string" ? data.action.new_value.draftId : null;
      if (draftId) setDrafts((current) => current.map((item) => item.id === draftId ? { ...item, status: "approved" } : item));
    }
    toast(data.message || (decision === "confirm" ? "Change confirmed" : "Change cancelled"), decision === "confirm" ? "ok" : "info");
    if (decision === "confirm") window.dispatchEvent(new CustomEvent("voom:data-changed", { detail: { tool: data.action.tool_name } }));
  }

  return <div className="grid gap-3.5 lg:grid-cols-[1fr_320px]" style={{ height: "calc(100dvh - 64px - 90px)" }}>
    <div className="flex flex-col overflow-hidden rounded-[var(--r-lg)] border border-line bg-surface">
      <div className="flex items-center gap-2.5 border-b border-line px-4.5 py-3.5"><Orb size="md" /><div className="min-w-0 flex-1"><b className="text-[15px]">MARA</b><div className="flex items-center gap-1.5 text-xs text-green"><span className="h-1.5 w-1.5 rounded-full bg-green" />Managing {brand.name}</div></div><button className="grid h-[38px] w-[38px] place-items-center rounded-[11px] text-text-2 hover:bg-surface-2" title="AI settings" onClick={() => toast("MARA is configured server-side", "info")}><Icon name="cog" /></button></div>
      <div ref={logRef} className="flex flex-1 flex-col gap-4 overflow-y-auto p-4.5">
        {loading && <p className="m-auto text-sm text-text-3">Loading MARA…</p>}
        {!loading && messages.length === 0 && <div className="flex max-w-[88%] gap-2.5 sm:max-w-[78%]"><Orb size="sm" className="mt-1" /><div className="rounded-[16px] rounded-bl-[5px] border border-line bg-surface-2 px-4 py-3 text-[14.2px] leading-[1.58]">Hi! I&apos;m MARA. I&apos;ve loaded your saved brand profile. Ask me a marketing question or have me create your first draft.</div></div>}
        {messages.map((message) => {
          const linkedDrafts = message.role === "assistant" ? drafts.filter((item) => item.message_id === message.id) : [];
          const linkedActions = message.role === "assistant" ? pendingActions.filter((item) => item.message_id === message.id) : [];
          const linkedMedia = message.role === "assistant" ? media.filter((item) => item.message_id === message.id) : [];
          return <div key={message.id} className="flex flex-col gap-2.5">
            <MessageBubble message={message} />
            {linkedDrafts.map((item) => <div key={item.id} className="ml-0 w-full sm:ml-10 sm:max-w-[calc(100%-2.5rem)]"><DraftCard draft={item} inline onCopy={() => void copyDraft(item.content)} onUpdate={updateDraft} onRegenerate={() => void send(`Regenerate the ${item.kind.replaceAll("_", " ")} draft titled "${item.title}" with a fresh approach.`)} disabled={sending} /></div>)}
            {linkedActions.map((item) => <div key={item.id} className="ml-0 w-full sm:ml-10 sm:max-w-[calc(100%-2.5rem)]"><PendingActionCard action={item} onDecision={decideAction} /></div>)}
            {linkedMedia.map((item) => <div key={item.id} className="ml-0 w-full sm:ml-10 sm:max-w-[calc(100%-2.5rem)]"><MediaCard media={item} onAction={updateMedia} onCopy={() => void copyDraft(item.prompt)} /></div>)}
          </div>;
        })}
        {streamingText && <MessageBubble message={{ id: "streaming", conversation_id: conversationId ?? "", role: "assistant", content: streamingText, created_at: "" }} />}
        {sending && !streamingText && <TypingBubble label="Checking Voom…" />}
      </div>
      <div className="border-t border-line p-3.5">
        {error && <div role="alert" className="mb-2.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>}
        <div className="mb-2.5 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">{QUICKS.map((quick) => <button key={quick} disabled={sending} onClick={() => void send(quick)} className="flex-none rounded-full border border-line bg-surface-2 px-3.5 py-1.5 text-[13px] font-medium text-text-2 hover:border-brand disabled:opacity-50">{quick}</button>)}</div>
        <div className="flex items-end gap-2.5 rounded-2xl border border-line bg-surface-2 py-2 pl-3.5 pr-2 focus-within:border-brand focus-within:ring-4 focus-within:ring-[var(--brand-soft)]"><textarea ref={textareaRef} rows={1} maxLength={4000} value={draft} placeholder="Ask MARA anything about your marketing…" className="max-h-[120px] flex-1 resize-none bg-transparent py-2 text-[14.5px] outline-none" onChange={(event) => { setDraft(event.target.value); event.target.style.height = "auto"; event.target.style.height = Math.min(event.target.scrollHeight, 120) + "px"; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(draft); } }} /><button aria-label="Send message" disabled={sending || !draft.trim()} className="grid h-[38px] w-[38px] flex-none place-items-center rounded-[11px] voom-grad text-white disabled:opacity-40" onClick={() => void send(draft)}><Icon name="send" size={16} /></button></div>
        <p className="mt-2 text-center text-[11.5px] text-text-3">AI can make mistakes. Approval saves a decision only—it never publishes or spends.</p>
      </div>
    </div>
    <aside className="hidden overflow-y-auto lg:block">
      <div className="mb-2.5 rounded-2xl border border-line bg-surface-2 p-3.5"><b className="text-[13px]">Brand profile</b><div className="my-2.5 h-px bg-line" /><div className="flex flex-col gap-2 text-[12.5px] text-text-2"><ProfileRow label="Brand" value={brand.name} /><ProfileRow label="Industry" value={brand.industry} /><ProfileRow label="Voice" value={brand.tone.join(", ")} /><div className="flex items-center justify-between"><span>Instagram</span>{igConnected ? <span className="rounded-[7px] bg-green/15 px-2.5 py-[3px] text-[11.5px] font-semibold text-green">Connected</span> : <button className="rounded-[7px] bg-amber/15 px-2.5 py-[3px] text-[11.5px] font-semibold text-amber" onClick={() => goTo("instagram")}>Connect</button>}</div></div><button className="mt-3 flex h-[34px] w-full items-center justify-center rounded-[9px] border border-line bg-surface text-[13px] font-semibold hover:bg-surface-3" onClick={() => goTo("settings")}>Edit brand</button></div>
      <div className="rounded-2xl border border-line bg-surface-2 p-3.5"><div className="flex items-center justify-between"><b className="text-[13px]">MARA drafts</b><span className="rounded-full bg-brand/15 px-2 py-0.5 text-[11px] font-semibold text-brand">{drafts.length}</span></div><div className="my-2.5 h-px bg-line" /><div className="flex flex-col gap-2.5">{drafts.length === 0 && <p className="text-[12.5px] leading-relaxed text-text-3">Generated captions, scripts, emails, SMS, plans, and calendars will appear here.</p>}{drafts.map((item) => <DraftCard key={item.id} onCopy={() => void copyDraft(item.content)} draft={item} onUpdate={updateDraft} onRegenerate={() => void send(`Regenerate the ${item.kind.replaceAll("_", " ")} draft titled "${item.title}" with a fresh approach.`)} disabled={sending} />)}</div></div>
    </aside>
  </div>;
}

type StreamEvent = { type: "start"; conversationId: string; userMessage: MaraMessageRecord } | { type: "delta"; content: string } | { type: "done"; assistantMessage: MaraMessageRecord; draft: MaraDraftRecord | null; pendingActions?: MaraPendingActionRecord[]; media?: MediaGenerationRecord | null };
function MessageBubble({ message }: { message: MaraMessageRecord }) { return message.role === "user" ? <div className="flex max-w-[88%] justify-end self-end sm:max-w-[78%]"><div className="whitespace-pre-wrap rounded-[16px] rounded-br-[5px] px-4 py-3 text-[14.2px] leading-[1.58] text-white voom-grad">{message.content}</div></div> : <div className="flex max-w-[88%] gap-2.5 sm:max-w-[78%]"><Orb size="sm" className="mt-1" /><div className="whitespace-pre-wrap rounded-[16px] rounded-bl-[5px] border border-line bg-surface-2 px-4 py-3 text-[14.2px] leading-[1.58]">{message.content}</div></div>; }
function TypingBubble({ label }: { label: string }) { return <div className="flex gap-2.5"><Orb size="sm" className="mt-1" /><div className="flex items-center gap-2 rounded-[16px] rounded-bl-[5px] border border-line bg-surface-2 px-4 py-3 text-sm text-text-2"><span>{label}</span><span className="flex gap-1">{[0, 160, 320].map((delay) => <span key={delay} className="h-[6px] w-[6px] animate-bounce rounded-full bg-text-3" style={{ animationDelay: `${delay}ms` }} />)}</span></div></div>; }
function ProfileRow({ label, value }: { label: string; value: string }) { return <div className="flex items-start justify-between gap-3"><span>{label}</span><b className="max-w-[180px] text-right text-text">{value || "—"}</b></div>; }

function DraftCard({ draft, onUpdate, onRegenerate, onCopy, disabled, inline = false }: { draft: MaraDraftRecord; onUpdate: (id: string, action: "approve" | "reject" | "edit", content?: string, proposedPublishAt?: string | null) => Promise<void>; onRegenerate: () => void; onCopy: () => void; disabled: boolean; inline?: boolean }) {
  const [editing, setEditing] = useState(false); const [content, setContent] = useState(draft.content); const [saving, setSaving] = useState(false);
  async function save() { setSaving(true); await onUpdate(draft.id, "edit", content, draft.proposed_publish_at); setSaving(false); setEditing(false); }
  return <article data-mara-draft-location={inline ? "inline" : "sidebar"} className={`rounded-xl border border-line bg-surface p-3 ${inline ? "border-brand/30 shadow-[0_12px_32px_rgba(0,0,0,.12)] sm:p-4" : ""}`}><div className="flex items-start justify-between gap-2"><div><span className="text-[10.5px] font-bold uppercase tracking-wide text-brand">{draft.channel} · {draft.kind.replaceAll("_", " ")}</span><h3 className={`mt-0.5 font-semibold ${inline ? "text-[14px]" : "text-[12.5px]"}`}>{draft.title}</h3></div><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${draft.status === "approved" ? "bg-green/15 text-green" : draft.status === "rejected" ? "bg-red/15 text-red" : "bg-amber/15 text-amber"}`}>{draft.status}</span></div>{editing ? <textarea value={content} maxLength={12000} onChange={(event) => setContent(event.target.value)} className="mt-3 min-h-64 w-full resize-y rounded-lg border border-line bg-surface-2 p-3 text-[13px] leading-relaxed outline-none focus:border-brand" /> : <div className={`mt-3 whitespace-pre-wrap text-text-2 ${inline ? "text-[13.5px] leading-[1.65]" : "line-clamp-6 text-xs leading-relaxed"}`}>{draft.content}</div>}{draft.kind === "sms" && <p className="mt-2 text-[10.5px] font-medium text-text-3">{draft.content.length} characters</p>}<p className="mt-2 text-[10.5px] text-text-3">Proposed: {draft.proposed_publish_at ? new Date(draft.proposed_publish_at).toLocaleString() : "Choose later"}</p><div className="mt-3 flex flex-wrap gap-1.5">{editing ? <><MiniButton onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</MiniButton><MiniButton onClick={() => { setEditing(false); setContent(draft.content); }}>Cancel</MiniButton></> : <><MiniButton onClick={onCopy}>Copy</MiniButton><MiniButton onClick={() => setEditing(true)}>Edit</MiniButton><MiniButton onClick={onRegenerate} disabled={disabled}>Regenerate</MiniButton><MiniButton onClick={() => void onUpdate(draft.id, "approve")} disabled={draft.status === "approved"}>Approve</MiniButton><MiniButton onClick={() => void onUpdate(draft.id, "reject")} disabled={draft.status === "rejected"}>Reject</MiniButton></>}</div>{inline && <p className="mt-3 text-[10.5px] text-text-3">Approval saves this status only. Nothing is published, sent, or funded.</p>}</article>;
}
function MiniButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) { return <button onClick={onClick} disabled={disabled} className="rounded-md border border-line px-2 py-1 text-[10.5px] font-semibold hover:border-brand disabled:opacity-40">{children}</button>; }

function MediaCard({ media, onAction, onCopy }: { media: MediaGenerationRecord; onAction: (id: string, action: "generate" | "confirm" | "cancel" | "regenerate" | "approve" | "reject" | "edit", prompt?: string) => Promise<void>; onCopy: () => void }) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(media.prompt);
  const busy = media.status === "processing" || media.status === "queued";
  const complete = media.status === "completed" && Boolean(media.asset_url);
  const failed = media.status === "failed";
  async function savePrompt() { await onAction(media.id, "edit", prompt); setEditing(false); }
  return <article className="overflow-hidden rounded-2xl border border-brand/30 bg-surface shadow-[0_12px_32px_rgba(0,0,0,.12)]" data-mara-media={media.media_type}>
    <div className="flex flex-wrap items-start justify-between gap-2 p-4 pb-3">
      <div><span className="text-[10.5px] font-bold uppercase tracking-wide text-brand">AI {media.media_type} · {media.aspect_ratio}</span><h3 className="mt-1 text-[14px] font-semibold">MARA-generated {media.media_type}</h3></div>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${media.approval_status === "approved" ? "bg-green/15 text-green" : media.approval_status === "rejected" || failed ? "bg-red/15 text-red" : "bg-amber/15 text-amber"}`}>{failed ? "failed" : media.approval_status !== "draft" ? media.approval_status : media.status.replaceAll("_", " ")}</span>
    </div>
    {complete ? <div className="relative mx-4 overflow-hidden rounded-xl border border-line bg-black" style={{ aspectRatio: media.aspect_ratio.replace(":", "/") }}>
      {media.media_type === "image" ? <Image src={media.asset_url!} alt="AI-generated marketing visual" fill unoptimized className="object-contain" sizes="(max-width: 640px) 100vw, 700px" /> : <video src={media.asset_url!} controls preload="metadata" playsInline className="h-full w-full object-contain">Your browser does not support video playback.</video>}
    </div> : <div className="mx-4 grid min-h-48 place-items-center rounded-xl border border-line bg-surface-2 p-6 text-center">
      {media.status === "pending_confirmation" ? <div><Icon name="video" size={28} className="mx-auto mb-3 text-brand" /><b className="text-sm">Ready to generate a {media.duration_seconds}-second video</b><p className="mt-1 text-xs text-text-3">Estimated provider cost: ${media.estimated_cost_usd?.toFixed(2) ?? "—"}. You will confirm before generation begins.</p></div> : failed ? <div><b className="text-sm text-red">Generation didn&apos;t complete</b><p className="mt-1 text-xs text-text-3">Nothing was published or charged again automatically. You can retry when ready.</p></div> : <div><span className="mx-auto mb-3 block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand" /><b className="text-sm">Generating your {media.media_type}…</b><p className="mt-1 text-xs text-text-3">This card is saved. You can leave and return.</p></div>}
    </div>}
    <div className="p-4">
      {editing ? <div><textarea value={prompt} maxLength={4000} onChange={(event) => setPrompt(event.target.value)} className="min-h-32 w-full resize-y rounded-lg border border-line bg-surface-2 p-3 text-xs leading-relaxed outline-none focus:border-brand" /><div className="mt-2 flex gap-2"><MiniButton onClick={() => void savePrompt()}>Save</MiniButton><MiniButton onClick={() => { setEditing(false); setPrompt(media.prompt); }}>Cancel</MiniButton></div></div> : <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-text-2">{media.prompt}</p>}
      {!editing && <div className="mt-3 flex flex-wrap gap-1.5">
        {media.status === "pending_confirmation" && <><button onClick={() => void onAction(media.id, "confirm")} className="rounded-md bg-brand px-3 py-1.5 text-[11px] font-semibold text-white">Confirm generation</button><MiniButton onClick={() => void onAction(media.id, "cancel")}>Cancel</MiniButton></>}
        {complete && <a href={media.asset_url!} download className="rounded-md border border-line px-2 py-1 text-[10.5px] font-semibold hover:border-brand">Download</a>}
        <MiniButton onClick={onCopy}>Copy prompt</MiniButton>
        <MiniButton onClick={() => setEditing(true)} disabled={busy}>Edit</MiniButton>
        <MiniButton onClick={() => void onAction(media.id, "regenerate")} disabled={busy}>Regenerate</MiniButton>
        <MiniButton onClick={() => void onAction(media.id, "approve")} disabled={!complete || media.approval_status === "approved"}>Approve</MiniButton>
        <MiniButton onClick={() => void onAction(media.id, "reject")} disabled={!complete || media.approval_status === "rejected"}>Reject</MiniButton>
      </div>}
      <p className="mt-3 text-[10.5px] text-text-3">Approval saves your decision only. It never publishes to Instagram or spends advertising money.</p>
    </div>
  </article>;
}

function PendingActionCard({ action, onDecision }: { action: MaraPendingActionRecord; onDecision: (id: string, decision: "confirm" | "cancel") => Promise<void> }) {
  const waiting = action.status === "pending"; const busy = action.status === "executing"; const failed = action.status === "failed";
  const link = action.tool_name.includes("calendar") ? { href: "/app/calendar", label: "View in calendar" } : action.tool_name.includes("campaign") ? { href: "/app/campaigns", label: "View campaign" } : { href: "/app/mara", label: "View draft" };
  return <article className="rounded-xl border border-brand/35 bg-[var(--brand-soft)] p-4" data-mara-pending-action={action.status}>
    <div className="flex flex-wrap items-start justify-between gap-2"><div><span className="text-[10.5px] font-bold uppercase tracking-wide text-brand">Voom change request</span><h3 className="mt-1 text-[14px] font-semibold">{action.summary}</h3></div><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${action.status === "confirmed" ? "bg-green/15 text-green" : action.status === "cancelled" ? "bg-surface-3 text-text-3" : failed ? "bg-red/15 text-red" : "bg-amber/15 text-amber"}`}>{busy ? "Working…" : action.status}</span></div>
    {action.old_value && <ActionValues label="Current" value={action.old_value} />}
    {action.new_value && <ActionValues label="Proposed" value={action.new_value} />}
    {action.result_summary && <p className="mt-3 text-sm font-medium text-text-2">{action.result_summary}</p>}
    {failed && <p className="mt-3 text-sm text-red">{action.error_summary || "Voom couldn't apply that change. Nothing unsafe was changed."}</p>}
    <div className="mt-3 flex flex-wrap gap-2">{(waiting || failed) && <><button disabled={busy} onClick={() => void onDecision(action.id, "confirm")} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white">{failed ? "Retry" : "Confirm"}</button>{waiting && <button onClick={() => void onDecision(action.id, "cancel")} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold">Cancel</button>}</>}<a href={link.href} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold">{link.label} →</a></div>
    <p className="mt-3 text-[10.5px] text-text-3">Confirmation changes Voom data only. Nothing is published, sent, or funded.</p>
  </article>;
}

function ActionValues({ label, value }: { label: string; value: Record<string, unknown> }) {
  const rows = Object.entries(value).filter(([key, item]) => !key.toLowerCase().includes("id") && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")).slice(0, 8);
  if (!rows.length) return null;
  return <div className="mt-3 rounded-lg border border-line/70 bg-surface/80 p-3"><b className="text-[11px] uppercase tracking-wide text-text-3">{label}</b><dl className="mt-2 grid gap-1.5 text-xs">{rows.map(([key, item]) => <div key={key} className="grid grid-cols-[110px_1fr] gap-2"><dt className="capitalize text-text-3">{key.replaceAll("_", " ")}</dt><dd className="break-words text-text">{formatActionValue(key, item)}</dd></div>)}</dl></div>;
}
function formatActionValue(key: string, value: unknown) { if (typeof value === "string" && (key.toLowerCase().includes("at") || key.toLowerCase().includes("time")) && !Number.isNaN(Date.parse(value))) return new Date(value).toLocaleString(); return String(value); }
