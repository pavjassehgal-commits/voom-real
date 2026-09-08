"use client";

import { useState } from "react";
import { useModal } from "@/lib/voom/modal";
import { Btn } from "@/components/voom/ui/primitives";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "@/components/voom/ui/Modal";
import { Icon } from "@/components/voom/icons";
import { PostEditorModal } from "./PostEditorModal";

type Step = "choose" | "instagram_post" | "reel" | "story";
type Kind = "instagram_post" | "reel" | "story";

/**
 * The single "Create content" entry point.
 *
 *   Create content → Instagram Post / Reel / Instagram Story
 *
 * Everything it creates stays internal: a draft, an approval, an internal
 * schedule, and a Content Calendar entry. It never calls Instagram.
 */
export function CreateContentModal({ onChanged }: { onChanged?: () => void }) {
  const { open, close } = useModal();
  const [step, setStep] = useState<Step>("choose");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(kind: Kind, origin: "mara" | "own_asset" | "existing_content") {
    setBusy(true);
    setError("");
    try {
      const concept = kind === "reel" ? "New Reel" : kind === "story" ? "New Instagram Story" : "New Instagram Post";
      const response = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, origin, concept }),
      });
      const body = await response.json() as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? "Voom couldn't start that draft.");
      onChanged?.();
      open(<PostEditorModal postId={body.id} onChanged={onChanged} />);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't start that draft.");
      setBusy(false);
    }
  }

  const title = step === "choose" ? "Create content"
    : step === "instagram_post" ? "Instagram Post"
    : step === "reel" ? "Reel"
    : "Instagram Story";

  return (
    <ModalShell wide maxWidth={620}>
      <ModalHead
        title={title}
        sub="Drafts, approvals and scheduling stay inside Voom. Nothing is published to Instagram."
        onClose={close}
      />
      <ModalBody>
        {error ? <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div> : null}

        {step === "choose" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice
              icon="ig"
              title="Instagram Post"
              body="A 1:1 or 4:5 feed post with a concept, caption, CTA, hashtags and a visual."
              onClick={() => setStep("instagram_post")}
            />
            <Choice
              icon="film"
              title="Reel"
              body="Import a video you already have, or use Voom's existing MARA Reel workflow."
              onClick={() => setStep("reel")}
            />
            <Choice
              icon="spark"
              title="Instagram Story"
              body="A 9:16 full-screen image or video. Upload one you already have, or let MARA create the visual."
              onClick={() => setStep("story")}
            />
          </div>
        ) : null}

        {step === "instagram_post" ? (
          <div className="space-y-3">
            <Choice
              icon="spark"
              title="Create with MARA"
              body="MARA writes the concept, caption, CTA and hashtags from your brand profile and active marketing plan, then generates the visual and stores it privately in Voom."
              onClick={() => void create("instagram_post", "mara")}
              busy={busy}
            />
            <Choice
              icon="img"
              title="Use my own asset"
              body="Upload your own image. It is stored privately and kept exactly as uploaded — no AI change unless you ask for one."
              onClick={() => void create("instagram_post", "own_asset")}
              busy={busy}
            />
            <p className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-text-3">
              Existing photo you already shot? Choose <b>Use my own asset</b>, then switch the source to
              <b> Existing content</b> in the editor to get caption, CTA and timing suggestions.
            </p>
          </div>
        ) : null}

        {step === "reel" ? (
          <div className="space-y-3">
            <Choice
              icon="img"
              title="Import an existing video"
              body="Turn a video you already have into a Reel draft. MARA can suggest a caption, CTA and timing from the file metadata and your brand context — it does not watch the video."
              onClick={() => void create("reel", "existing_content")}
              busy={busy}
            />
            <Choice
              icon="film"
              title="Use the existing Reel workflow"
              body="The full MARA Reel production flow (concept, script, asset pack, playable preview) lives under Approvals and is unchanged."
              onClick={() => { close(); }}
              href="/app/approvals"
            />
          </div>
        ) : null}

        {step === "story" ? (
          <div className="space-y-3">
            <Choice
              icon="img"
              title="Upload an image or video"
              body="Use a 9:16 image (JPEG or PNG) or video (MP4) you already have. It is stored privately and kept exactly as uploaded. Stories don't support captions."
              onClick={() => void create("story", "existing_content")}
              busy={busy}
            />
            <Choice
              icon="spark"
              title="Create with MARA"
              body="MARA plans a full-screen 9:16 visual from your brand profile and active marketing plan, generates it, and stores it privately in Voom."
              onClick={() => void create("story", "mara")}
              busy={busy}
            />
            <p className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-text-3">
              Instagram Stories are 9:16 full screen and expire after 24 hours. Instagram does not support captions on
              Stories, so Voom publishes the image or video exactly as stored.
            </p>
          </div>
        ) : null}
      </ModalBody>
      <ModalFoot>
        {step !== "choose" ? <Btn variant="ghost" onClick={() => { setStep("choose"); setError(""); }}>Back</Btn> : null}
        <Btn variant="primary" onClick={close}>Done</Btn>
      </ModalFoot>
    </ModalShell>
  );
}

function Choice({ icon, title, body, onClick, busy, href }: {
  icon: string; title: string; body: string; onClick: () => void; busy?: boolean; href?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-start gap-3 rounded-2xl border border-line bg-surface p-4 text-left transition hover:border-brand hover:bg-surface-2 disabled:opacity-60"
    >
      <span className="voom-grad grid h-9 w-9 flex-none place-items-center rounded-xl text-white">
        {href ? <a href={href} className="grid place-items-center" aria-label={title}><Icon name={icon} size={16} /></a> : <Icon name={icon} size={16} />}
      </span>
      <span className="min-w-0">
        <b className="block text-[14.5px]">{busy ? "Starting…" : title}</b>
        <span className="mt-1 block text-[12.5px] leading-relaxed text-text-2">{body}</span>
      </span>
    </button>
  );
}
