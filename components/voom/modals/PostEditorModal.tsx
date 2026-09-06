"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import { Btn, Card, Chip, Field, Input, Tag, Textarea } from "@/components/voom/ui/primitives";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "@/components/voom/ui/Modal";
import { Icon } from "@/components/voom/icons";
import { formatAspectRatio, POST_FORMATS, type PostFormat } from "@/lib/post/core";
import { formatIngestionClientError } from "@/lib/media/ingestion-error";

interface PostVisual {
  displayName: string;
  mimeType: string;
  byteSize: number;
  format: PostFormat;
  previewUrl: string | null;
}

interface Post {
  id: string;
  kind: "instagram_post" | "reel";
  typeLabel: string;
  concept: string;
  caption: string;
  cta: string;
  hashtags: string[];
  format: PostFormat;
  origin: "mara" | "own_asset" | "existing_content";
  originLabel: string;
  internalState: "draft" | "approved" | "scheduled_internal" | "ready_to_publish";
  internalStateLabel: string;
  scheduledAt: string | null;
  visual: PostVisual | null;
  visualReady: boolean;
}

const STATE_TONE: Record<Post["internalState"], string> = {
  draft: "t-amber",
  approved: "t-blue",
  scheduled_internal: "t-green",
  ready_to_publish: "t-green",
};

export function PostEditorModal({ postId, onChanged }: { postId: string; onChanged?: () => void }) {
  const { close } = useModal();
  const fileRef = useRef<HTMLInputElement>(null);
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [concept, setConcept] = useState("");
  const [caption, setCaption] = useState("");
  const [cta, setCta] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [format, setFormat] = useState<PostFormat>("1:1");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(postId)}`, { cache: "no-store" });
      const body = await response.json() as { post?: Post; error?: string };
      if (!response.ok || !body.post) throw new Error(body.error ?? "That post couldn't load.");
      setPost(body.post);
      setConcept(body.post.concept);
      setCaption(body.post.caption);
      setCta(body.post.cta);
      setHashtags(body.post.hashtags.join(" "));
      setFormat(body.post.format);
      const when = body.post.scheduledAt ? new Date(body.post.scheduledAt) : null;
      setDate(when ? localDate(when) : "");
      setTime(when ? localTime(when) : "");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That post couldn't load.");
    }
  }, [postId]);

  // Deferred so the fetch callback is not a synchronous setState in the effect.
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function send(url: string, init: RequestInit | undefined, action: string, okMessage: string) {
    setBusy(action); setError(""); setNotice("");
    try {
      const response = await fetch(url, init);
      const body = await response.json() as { post?: Post; error?: string; code?: string; requestId?: string; message?: string; disclosure?: string };
      if (!response.ok) throw new Error(formatIngestionClientError({ error: body.error, code: body.code }, "That didn't work. Please retry."));
      if (body.post) {
        setPost(body.post);
        setConcept(body.post.concept); setCaption(body.post.caption); setCta(body.post.cta);
        setHashtags(body.post.hashtags.join(" ")); setFormat(body.post.format);
        const when = body.post.scheduledAt ? new Date(body.post.scheduledAt) : null;
        setDate(when ? localDate(when) : ""); setTime(when ? localTime(when) : "");
      }
      setNotice(`${body.message ?? okMessage}${body.disclosure ? ` ${body.disclosure}` : ""}`);
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That didn't work. Please retry.");
    } finally {
      setBusy(null);
    }
  }

  const endpoint = `/api/posts/${encodeURIComponent(postId)}`;
  const saveBody = () => JSON.stringify({
    action: "save",
    concept,
    caption,
    cta,
    hashtags: hashtags.split(/[\s,]+/).filter(Boolean),
    format,
    scheduledAt: date ? new Date(`${date}T${time || "09:00"}`).toISOString() : null,
  });

  async function uploadFile(file: File, origin: "own_asset" | "existing_content") {
    const form = new FormData();
    form.set("file", file);
    form.set("origin", origin);
    // No format is sent: the draft's persisted format wins, so an upload can
    // never change the framing the user chose.
    await send(`${endpoint}/asset`, { method: "POST", body: form }, "upload", "Stored privately in Voom.");
  }

  /**
   * The format is persisted on the draft immediately, so it survives a reload
   * even when this post has no visual yet.
   */
  async function chooseFormat(value: PostFormat) {
    setFormat(value);
    await send(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", format: value }),
    }, "format", `Format set to ${value}.`);
  }

  const isPost = post?.kind === "instagram_post";
  const isReel = post?.kind === "reel";

  return (
    <ModalShell wide maxWidth={760}>
      <ModalHead
        title={
          <>
            <span className="mb-2 flex flex-wrap gap-1.5">
              <Tag tone="t-brand">{post?.typeLabel ?? "Content"}</Tag>
              {post ? <Tag tone={STATE_TONE[post.internalState]}>{post.internalStateLabel}</Tag> : null}
              {post ? <Tag tone="t-grey">{post.originLabel}</Tag> : null}
            </span>
            <div>{concept || "Untitled"}</div>
          </>
        }
        sub="Saved inside Voom only. Nothing is published to Instagram."
        onClose={close}
      />
      <ModalBody>
        {error ? <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div> : null}
        {notice ? <div role="status" className="mb-3.5 rounded-xl border border-green/35 bg-green/10 px-3.5 py-2.5 text-sm text-green">{notice}</div> : null}
        {!post && !error ? <div className="py-10 text-center text-sm text-text-3">Loading this post…</div> : null}

        {post ? (
          <div className="grid gap-5 md:grid-cols-[300px_1fr]">
            <div>
              <h3 className="mb-2 text-xs font-semibold text-text-2">Preview</h3>
              <div className="overflow-hidden rounded-2xl border border-line bg-surface-2">
                <div className="grid w-full place-items-center bg-black/90" style={{ aspectRatio: formatAspectRatio(format) }}>
                  {post.visual?.previewUrl ? (
                    post.visual.mimeType.startsWith("video/") ? (
                      <video src={post.visual.previewUrl} controls playsInline className="h-full w-full object-cover" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={post.visual.previewUrl} alt={post.visual.displayName} className="h-full w-full object-cover" />
                    )
                  ) : (
                    <span className="px-4 text-center text-xs text-text-3">
                      No visual yet. Nothing shows here until Voom stores the bytes.
                    </span>
                  )}
                </div>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-text-3">
                {post.visual
                  ? `${post.visual.displayName} · ${(post.visual.byteSize / 1024).toFixed(0)} KB · private signed preview`
                  : "Private previews are short-lived signed URLs. The file path is never sent to your browser."}
              </p>

              <div className="mt-3.5">
                <h3 className="mb-1.5 text-xs font-semibold text-text-2">Format</h3>
                <p className="mb-1.5 text-[11px] leading-relaxed text-text-3">
                  Saved with the draft, so it is still {format} when you come back — even before a visual exists.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {POST_FORMATS.map((value) => (
                    <Chip key={value} active={format === value} onClick={() => void chooseFormat(value)}>{value}</Chip>
                  ))}
                </div>
              </div>

              <div className="mt-3.5 space-y-2">
                {isPost && !post.visualReady ? (
                  <Btn variant="primary" size="sm" block disabled={busy === "mara"} onClick={() => void send(`${endpoint}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }, "mara", "MARA created this post.")}>
                    <Icon name="spark" size={14} /> {busy === "mara" ? "MARA is working…" : "Create with MARA"}
                  </Btn>
                ) : null}

                <input
                  ref={fileRef}
                  type="file"
                  accept={isReel ? ".jpg,.jpeg,.png,.webp,.mp4,.mov" : ".jpg,.jpeg,.png,.webp"}
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void uploadFile(file, post.origin === "existing_content" || post.kind === "reel" ? "existing_content" : "own_asset");
                  }}
                />
                <Btn variant="outline" size="sm" block disabled={busy === "upload"} onClick={() => fileRef.current?.click()}>
                  <Icon name="img" size={14} /> {busy === "upload" ? "Storing…" : post.visualReady ? "Replace visual" : isReel ? "Import an existing video or image" : "Use my own asset"}
                </Btn>

                {post.origin === "existing_content" ? (
                  <Btn variant="outline" size="sm" block disabled={busy === "suggest"} onClick={async () => {
                    setBusy("suggest"); setError(""); setNotice("");
                    try {
                      const response = await fetch(`${endpoint}/suggest`, { method: "POST" });
                      const body = await response.json() as { suggestion?: { caption: string; cta: string; hashtags: string[]; suggestedPublishAt: string | null }; error?: string; disclosure?: string };
                      if (!response.ok || !body.suggestion) throw new Error(body.error ?? "MARA couldn't suggest copy.");
                      setCaption(body.suggestion.caption);
                      setCta(body.suggestion.cta);
                      setHashtags(body.suggestion.hashtags.join(" "));
                      if (body.suggestion.suggestedPublishAt) {
                        const when = new Date(body.suggestion.suggestedPublishAt);
                        setDate(localDate(when)); setTime(localTime(when));
                      }
                      setNotice(body.disclosure ?? "MARA suggested copy. Review it before saving.");
                    } catch (reason) {
                      setError(reason instanceof Error ? reason.message : "MARA couldn't suggest copy.");
                    } finally {
                      setBusy(null);
                    }
                  }}>
                    <Icon name="spark" size={14} /> {busy === "suggest" ? "MARA is writing…" : "Suggest caption, CTA and timing"}
                  </Btn>
                ) : null}

                {post.visualReady ? (
                  <Btn variant="ghost" size="sm" block disabled={busy === "remove"} onClick={() => void send(`${endpoint}/asset`, { method: "DELETE" }, "remove", "Visual removed.")}>
                    <Icon name="trash" size={14} /> Remove visual
                  </Btn>
                ) : null}
              </div>

              {post.origin === "existing_content" ? (
                <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2.5 text-[11.5px] leading-relaxed text-text-3">
                  MARA has not seen this file. Suggestions come from the file name, file type and your brand and plan
                  context only.
                </p>
              ) : null}
            </div>

            <div>
              <Field label="Title / concept">
                <Input value={concept} maxLength={160} onChange={(event) => setConcept(event.target.value)} />
              </Field>
              <Field label="Caption">
                <Textarea rows={7} maxLength={2200} value={caption} onChange={(event) => setCaption(event.target.value)} />
              </Field>
              <Field label="Call to action" hint="One short action for the reader.">
                <Input value={cta} maxLength={160} onChange={(event) => setCta(event.target.value)} placeholder="Book a fitting this week" />
              </Field>
              <Field label="Hashtags" hint="Space separated, without the # symbol. Optional.">
                <Input value={hashtags} onChange={(event) => setHashtags(event.target.value)} placeholder="summerfit familyoutfit" />
              </Field>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <Field label="Schedule date">
                  <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
                </Field>
                <Field label="Time">
                  <Input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
                </Field>
              </div>

              <Card className="border-line bg-surface-2 p-3">
                <p className="text-[11.5px] leading-relaxed text-text-3">
                  <b className="text-text-2">How Voom labels this:</b> Draft → Approved → Scheduled internally →
                  Ready to publish. Voom never shows “Posted”, because publishing to Instagram is not connected.
                </p>
              </Card>
            </div>
          </div>
        ) : null}
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>Close</Btn>
        {post ? (
          <>
            <Btn variant="outline" disabled={busy !== null} onClick={() => void send(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: saveBody() }, "save", "Saved as a draft.")}>
              {busy === "save" ? "Saving…" : "Save Draft"}
            </Btn>
            <Btn variant="primary" disabled={busy !== null} onClick={() => void send(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }) }, "approve", "Approved inside Voom.")}>
              {busy === "approve" ? "Approving…" : "Approve"}
            </Btn>
          </>
        ) : null}
      </ModalFoot>
    </ModalShell>
  );
}

function localDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function localTime(value: Date) {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}
