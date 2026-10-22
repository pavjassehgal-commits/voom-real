"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/voom/icons";
import { PostEditorModal } from "@/components/voom/modals/PostEditorModal";
import { SocialEditorModal } from "@/components/voom/modals/SocialEditorModal";
import { BTN, ChannelGlyph, CreateStepper, PageHeader, StatusChip } from "@/components/voom/redesign/ui";
import type { CreateDraft, ReadinessCheck } from "@/lib/voom/create-readiness";
import { useModal } from "@/lib/voom/modal";
import { cx } from "@/lib/voom/cx";

const CHANNEL_NAME = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" } as const;

/**
 * Create · Step 2 · Preview. Shows the stored media and caption in the
 * channel's frame with readiness checks computed from the draft itself.
 * Composing happens in the existing editor for this format.
 */
export function CreatePreview({ draft, connected, checks }: { draft: CreateDraft; connected: boolean | null; checks: ReadinessCheck[] }) {
  const router = useRouter();
  const { open } = useModal();
  const openEditor = () => {
    const onChanged = () => router.refresh();
    open(draft.editor === "social" ? <SocialEditorModal draftId={draft.id} onChanged={onChanged} /> : <PostEditorModal postId={draft.id} onChanged={onChanged} />);
  };
  const failing = checks.filter((check) => !check.ok).length;
  const ready = failing === 0 && connected !== false;

  return (
    <div className="min-w-0 pb-24">
      <PageHeader
        title={`Preview your ${draft.typeLabel.replace(/^Instagram /, "")}`}
        subtitle={<span className="flex flex-wrap items-center gap-2 text-[14px]"><StatusChip status={draft.status === "approved" ? "scheduled" : "draft"} label={draft.status === "approved" ? "Approved" : "Draft"} small /><span>Saved in Voom · nothing is published from this step</span></span>}
        actions={<CreateStepper step={2} />}
      />

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <section className="voom-card min-w-0 p-5 sm:p-6" aria-labelledby="preview-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="preview-title" className="text-[17px] font-semibold text-text">How it will look on {CHANNEL_NAME[draft.channel]}</h2>
            <span className="inline-flex items-center gap-2 rounded-full bg-[var(--brand-soft)] px-3 py-1.5 text-[13px] font-semibold text-[var(--brand-ink)]"><ChannelGlyph channel={draft.channel} size={18} />{draft.typeLabel}</span>
          </div>
          <div className="mt-5 grid min-w-0 gap-6 md:grid-cols-[300px_minmax(0,1fr)]">
            <PhoneFrame draft={draft} />
            <div className="min-w-0">
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-text-3">{CHANNEL_NAME[draft.channel]} {draft.typeLabel.replace(/^(Instagram|TikTok|YouTube) /, "")} checks</h3>
              <ul className="mt-3 space-y-2.5">
                {checks.map((check) => (
                  <li key={check.label} className="flex items-start gap-3 rounded-[14px] border border-line px-4 py-3">
                    <span className={cx("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full", check.ok ? "text-[var(--green)]" : "bg-[var(--amber-soft)] text-[var(--amber)]")}>
                      <Icon name={check.ok ? "check" : "warn"} size={13} />
                    </span>
                    <span className="min-w-0"><span className="block text-[14.5px] font-semibold text-text">{check.label}</span><span className="block text-[13px] text-text-2">{check.detail}</span></span>
                  </li>
                ))}
              </ul>
              <button type="button" onClick={openEditor} className={cx(BTN.outline, "mt-4")}><Icon name="pencil" size={14} /> Edit caption and media</button>
            </div>
          </div>
        </section>

        <aside className="flex min-w-0 flex-col gap-5">
          <section className="voom-card p-5 sm:p-6" aria-labelledby="preview-channels">
            <h2 id="preview-channels" className="text-[16px] font-semibold text-text">Ready for 1 channel</h2>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-3">
                <ChannelGlyph channel={draft.channel} size={24} />
                <span className="min-w-0"><span className="block font-semibold text-text">{CHANNEL_NAME[draft.channel]}</span><span className="block truncate text-[12.5px] text-text-2">{draft.typeLabel}</span></span>
              </span>
              <StatusChip status={ready ? "published" : connected === false ? "connection_required" : "needs_approval"} label={ready ? "Ready" : connected === false ? "Not connected" : `${failing} to fix`} small />
            </div>
            <p className="mt-4 text-[12.5px] leading-relaxed text-text-3">Each Voom post goes to one channel. To post on another channel, create a separate post for it.</p>
          </section>
          {connected === false && (
            <section className="rounded-[18px] border border-[rgba(198,88,40,0.25)] bg-[var(--coral-soft)] p-4 text-[13.5px] leading-relaxed text-text">
              <p className="flex gap-2"><Icon name="warn" size={16} className="mt-0.5 shrink-0 text-[var(--coral)]" /><span>{CHANNEL_NAME[draft.channel]} isn’t connected. You can still prepare and approve this post, but Voom can’t publish it until you connect the account.</span></p>
              <Link href={`/app/${draft.channel}`} className="mt-3 inline-flex font-semibold text-[var(--coral)] hover:underline">Connect {CHANNEL_NAME[draft.channel]}</Link>
            </section>
          )}
        </aside>
      </div>

      <StepFooter>
        <button type="button" onClick={openEditor} className="inline-flex items-center gap-2 text-[14px] font-medium text-text-2 hover:text-text"><Icon name="back" size={15} /> Back to compose</button>
        <div className="flex gap-2.5">
          <Link href={`/app/content/${draft.id}`} className={cx(BTN.quiet, "rounded-full")}>Save draft</Link>
          <Link href={`/app/studio/${draft.id}/schedule`} className={BTN.primary}>Continue to schedule <Icon name="arrow" size={15} /></Link>
        </div>
      </StepFooter>
    </div>
  );
}

export function PhoneFrame({ draft }: { draft: CreateDraft }) {
  const horizontal = draft.kind === "youtube_video";
  const square = draft.kind === "instagram_post";
  const isVideo = draft.mimeType?.startsWith("video");
  return (
    <div className="mx-auto w-full max-w-[300px]">
      <div className="rounded-[40px] bg-[#16181f] p-3 shadow-[var(--shadow-lg)]">
        <div className="relative flex aspect-[9/18] flex-col overflow-hidden rounded-[30px] bg-[linear-gradient(170deg,#c9c3ff,#a9d8f0)]">
          <div className="mx-auto mt-2 h-5 w-24 rounded-full bg-[#16181f]" aria-hidden="true" />
          <div className={cx("relative mx-auto mt-6 w-full overflow-hidden bg-white/25", horizontal ? "aspect-video" : square ? "aspect-square" : "flex-1")}>
            {draft.previewUrl ? (
              isVideo
                ? <video src={draft.previewUrl} className="absolute inset-0 h-full w-full object-cover" muted playsInline controls aria-label="Stored video preview" />
                // eslint-disable-next-line @next/next/no-img-element -- short-lived signed preview URL
                : <img src={draft.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <div className="grid h-full min-h-[160px] place-items-center px-6 text-center text-[12.5px] font-medium text-white/90">{draft.mediaReady ? `${draft.mediaName ?? "Media"} attached` : "No media yet"}</div>
            )}
          </div>
          {draft.kind !== "story" && (
            <div className={cx("p-4 text-[12px] leading-snug text-white", !horizontal && !square && "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/45 to-transparent pt-10")}>
              <p className="font-semibold">{draft.title || "Untitled"}</p>
              {(draft.caption || draft.description) && <p className="mt-1 line-clamp-3 text-white/85">{draft.caption || draft.description}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function StepFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-[68px] z-20 border-t border-line bg-[var(--topbar-bg)] backdrop-blur-[16px] md:bottom-0 md:left-[264px]">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-10">{children}</div>
    </div>
  );
}
