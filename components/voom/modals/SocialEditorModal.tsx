"use client";

import { useCallback, useEffect, useState } from "react";
import { Btn, Field, Input, Tag, Textarea } from "@/components/voom/ui/primitives";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "@/components/voom/ui/Modal";

/**
 * Multi-Social Core — the editor for ONE TikTok or YouTube draft.
 *
 * Text, schedule, the explicit YouTube declarations (audience + privacy) and
 * the approval decision are recorded here. The banner states the truth per
 * channel: TikTok publishing is not connected, so approval never publishes
 * anything there; YouTube approval + schedule places the item on the durable
 * YouTube publish queue, and only YouTube's own confirmation (a real video id
 * with processing finished) ever makes it Published. No credit is spent and
 * no media is generated from this editor.
 */

interface SocialDraft {
  id: string;
  kind: "tiktok_video" | "youtube_short" | "youtube_video";
  typeLabel: string;
  channel: "tiktok" | "youtube";
  format: "video" | "short";
  title: string;
  caption: string;
  description: string | null;
  concept: string | null;
  script: string[];
  status: "draft" | "approved" | "rejected";
  scheduledAt: string | null;
  publishStateLabel: string;
  madeForKids: boolean | null;
  privacy: "public" | "private" | "unlisted" | null;
  queueStatus: string | null;
  queueFailureMessage: string | null;
  asset: { displayName: string; mimeType: string } | null;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SocialEditorModal({ draftId, onChanged }: { draftId: string; onChanged?: () => void }) {
  const [draft, setDraft] = useState<SocialDraft | null>(null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [description, setDescription] = useState("");
  const [script, setScript] = useState("");
  const [schedule, setSchedule] = useState("");
  const [madeForKids, setMadeForKids] = useState("");
  const [privacy, setPrivacy] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/social-drafts/${draftId}`, { cache: "no-store" });
      const body = await response.json() as { draft?: SocialDraft; error?: string };
      if (!response.ok || !body.draft) throw new Error(body.error ?? "Voom couldn't load that content.");
      setDraft(body.draft);
      setTitle(body.draft.title);
      setCaption(body.draft.caption);
      setDescription(body.draft.description ?? "");
      setScript((body.draft.script ?? []).join("\n"));
      setSchedule(toLocalInput(body.draft.scheduledAt));
      setMadeForKids(body.draft.madeForKids === null || body.draft.madeForKids === undefined ? "" : String(body.draft.madeForKids));
      setPrivacy(body.draft.privacy ?? "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't load that content.");
    }
  }, [draftId]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function save(decision?: "approved" | "draft") {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/social-drafts/${draftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          caption: caption.trim(),
          ...(draft.channel === "youtube"
            ? {
                description: description.trim(),
                madeForKids: madeForKids === "" ? null : madeForKids === "true",
                privacy: privacy === "" ? null : privacy,
              }
            : {}),
          script: script.split("\n").map((line) => line.trim()).filter(Boolean),
          scheduledAt: schedule ? new Date(schedule).toISOString() : null,
          ...(decision ? { decision } : {}),
        }),
      });
      const body = await response.json() as { draft?: SocialDraft; error?: string };
      if (!response.ok || !body.draft) throw new Error(body.error ?? "Voom couldn't save that content.");
      setDraft(body.draft);
      setMadeForKids(body.draft.madeForKids === null || body.draft.madeForKids === undefined ? "" : String(body.draft.madeForKids));
      setPrivacy(body.draft.privacy ?? "");
      onChanged?.();
      window.dispatchEvent(new Event("voom:data-changed"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't save that content.");
    } finally {
      setBusy(false);
    }
  }

  if (!draft) {
    return (
      <ModalShell wide maxWidth={640}>
        <ModalHead title="Content" sub="Loading…" onClose={() => window.history.back()} />
        <ModalBody>
          {error
            ? <div role="alert" className="rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>
            : <p className="text-sm text-text-3">Loading your draft…</p>}
        </ModalBody>
      </ModalShell>
    );
  }

  const isYouTubeVideo = draft.kind === "youtube_video";

  return (
    <ModalShell wide maxWidth={640}>
      <ModalHead
        title={draft.typeLabel}
        sub="Planned inside Voom · approval is never publication"
        onClose={() => window.history.back()}
      />
      <ModalBody>
        <div role="status" className="mb-3.5 rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber">
          {draft.channel === "tiktok"
            ? "TikTok publishing is not connected yet. You can plan, approve and schedule this video inside Voom; Voom will never claim it was published."
            : "Approving with a schedule puts this video on Voom's durable YouTube publish queue. The worker uploads at the scheduled time and Voom reports Published only after YouTube confirms the video is processed — approval is never publication."}
        </div>

        {draft.channel === "youtube" && draft.queueFailureMessage ? (
          <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-red">
            {draft.queueFailureMessage}
          </div>
        ) : null}

        {error ? <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div> : null}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Tag tone="t-grey">{draft.typeLabel}</Tag>
          <Tag tone={draft.status === "approved" ? "t-blue" : "t-amber"}>{draft.publishStateLabel}</Tag>
          {draft.asset ? <Tag tone="t-green">Video attached: {draft.asset.displayName}</Tag> : <Tag tone="t-grey">No video attached yet</Tag>}
        </div>

        <Field label="Title" hint={isYouTubeVideo ? "Search-friendly — front-load the topic." : "A short internal name."}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
        </Field>

        <Field
          label={draft.channel === "tiktok" ? "Caption" : "Caption"}
          hint={draft.channel === "tiktok" ? "One short TikTok-native line + 3-5 tags." : "The video caption."}
        >
          <Textarea rows={3} value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={4000} />
        </Field>

        {draft.channel === "youtube" && (
          <Field
            label="Description"
            hint={isYouTubeVideo ? "2-4 sentences with the payoff and chapters." : "1-2 lines for the Short."}
          >
            <Textarea rows={isYouTubeVideo ? 4 : 2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
          </Field>
        )}

        <Field
          label={draft.channel === "tiktok" ? "Beat list" : isYouTubeVideo ? "Outline / script" : "Beat list"}
          hint="One line per beat or section. Planning text only — no video is generated."
        >
          <Textarea rows={5} value={script} onChange={(e) => setScript(e.target.value)} placeholder={"Hook…\nSection 1…\nClose…"} />
        </Field>

        {draft.channel === "youtube" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Audience (required by YouTube)" hint="YouTube's COPPA declaration. Voom never guesses this — undeclared items wait visibly instead of publishing.">
              <select
                value={madeForKids}
                onChange={(e) => setMadeForKids(e.target.value)}
                className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm"
              >
                <option value="">Not declared yet</option>
                <option value="false">Not made for kids</option>
                <option value="true">Made for kids</option>
              </select>
            </Field>
            <Field label="Privacy" hint="The privacy YouTube is asked to apply. Google may lock unaudited API projects to private; Voom shows what YouTube actually applied.">
              <select
                value={privacy}
                onChange={(e) => setPrivacy(e.target.value)}
                className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm"
              >
                <option value="">Not declared yet</option>
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </Field>
          </div>
        )}

        <Field label="Schedule (optional)" hint={draft.channel === "youtube" ? "When the YouTube queue worker uploads this video. Times use your device clock." : "When this should go out once publishing is available. Times use your device clock."}>
          <Input type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
        </Field>
      </ModalBody>
      <ModalFoot className="justify-between">
        <Btn variant="outline" disabled={busy} onClick={() => void save()}>Save draft</Btn>
        <div className="flex gap-2">
          {draft.status === "approved"
            ? <Btn variant="ghost" disabled={busy} onClick={() => void save("draft")}>Move back to draft</Btn>
            : <Btn variant="primary" disabled={busy} onClick={() => void save("approved")}>Approve</Btn>}
        </div>
      </ModalFoot>
    </ModalShell>
  );
}
